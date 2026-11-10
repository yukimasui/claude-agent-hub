// Agent Hub サーバにゃ。外部依存なしの Node 標準モジュールだけで動くにゃ
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  CLAUDE_BIN,
  DEFAULT_MODEL,
  EVENTS_DIR,
  HEARTBEAT_FILE,
  HOOK_EVENTS,
  HOOK_SCRIPT,
  HOOKS_FILE,
  HOST,
  HUB_HOME,
  HUB_SYSTEM_PROMPT,
  INTERACTIVE_EVENTS,
  INTERACTIVE_TIMEOUT_SEC,
  PORT,
  PUBLIC_DIR,
  REQUESTS_DIR,
  RESPONSES_DIR,
  TMUX_SESSION,
  TOOL_EVENTS,
  WORKSPACES_DIR,
} from './lib/config.js';
import { Store, publicAgent } from './lib/store.js';
import { buildOutput } from './lib/interactions.js';
import { INTERRUPT_PAUSE_NOTE, applyQueueOp, proposalPauseNote, sendBlockReason } from './lib/queue.js';
import * as tmux from './lib/tmux.js';
import { readTranscript, readTranscriptImage } from './lib/transcript.js';
import { IMAGE_PATH_RE, checkImageRequest, checkRequest, httpError, sendImage } from './lib/http.js';

const store = new Store();

// ---------- 起動準備 ----------

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** --settings で渡す hook 設定を生成するにゃ。グローバル設定は汚さないにゃ */
function writeHooksFile() {
  fs.mkdirSync(HUB_HOME, { recursive: true });
  const command = `${shq(process.execPath)} ${shq(HOOK_SCRIPT)}`;
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((e) => [
      e,
      [
        {
          ...(TOOL_EVENTS.has(e) ? { matcher: '*' } : {}),
          hooks: [{ type: 'command', command, timeout: INTERACTIVE_EVENTS.has(e) ? INTERACTIVE_TIMEOUT_SEC : 10 }],
        },
      ],
    ]),
  );
  fs.writeFileSync(HOOKS_FILE, JSON.stringify({ hooks }, null, 2));
}

function buildCommand(a, { resume = false, prompt } = {}) {
  const args = [CLAUDE_BIN, '--model', a.model, '--settings', HOOKS_FILE];
  if (a.permissionMode) args.push('--permission-mode', a.permissionMode);
  args.push('--append-system-prompt', HUB_SYSTEM_PROMPT);
  args.push(resume ? '--resume' : '--session-id', a.sessionId);
  if (prompt) args.push('--', prompt);
  return args.map(shq).join(' ');
}

function agentEnv(a) {
  return { AGENT_HUB_AGENT: a.id, AGENT_HUB_HOME: HUB_HOME, PATH: process.env.PATH };
}

function resolveDir(p) {
  if (!p) return null;
  return path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
}

// ---------- エージェント操作 ----------

// 空文字はユーザー設定に従う（フラグを渡さない）にゃ
const PERMISSION_MODES = new Set(['manual', 'acceptEdits', 'auto', 'plan']);
// ステータス表示の猫の毛色にゃ（空文字はおまかせ）
const COATS = new Set(['orange', 'gray', 'cream', 'siamese', 'black', 'calico']);

async function createAgent(body) {
  const name = String(body.name || '').trim().slice(0, 40) || `agent-${store.list().length + 1}`;
  const model = String(body.model || DEFAULT_MODEL).trim();
  if (!/^[\w.:\[\]-]+$/.test(model)) throw httpError(400, 'モデル名が不正です');
  const permissionMode = PERMISSION_MODES.has(body.permissionMode) ? body.permissionMode : '';
  const id = 'a' + randomBytes(4).toString('hex');

  let cwd = resolveDir(body.cwd);
  if (cwd) {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw httpError(400, `ディレクトリが存在しません: ${cwd}`);
  } else {
    const slug = name.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || id;
    cwd = path.join(WORKSPACES_DIR, slug);
    fs.mkdirSync(cwd, { recursive: true });
  }

  const coat = COATS.has(body.coat) ? body.coat : '';
  const base = { id, name, model, cwd, permissionMode, coat, sessionId: randomUUID(), createdAt: Date.now() };
  const prompt = String(body.prompt || '').trim();
  const { windowId, paneId } = await tmux.createWindow({
    name: name.replace(/[^\w.-]+/g, '_'),
    cwd,
    env: agentEnv(base),
    command: buildCommand(base, { prompt }),
  });
  return store.add({ ...base, windowId, paneId });
}

async function restartAgent(a) {
  // 会話が始まっていれば resume、まだなら新しいセッションで起動するにゃ
  const resume = !!(a.transcriptPath && fs.existsSync(a.transcriptPath));
  if (!resume) a.sessionId = randomUUID();
  const command = buildCommand(a, { resume });
  const panes = await tmux.listPanes();
  if (a.paneId && panes.has(a.paneId)) {
    await tmux.respawnPane({ paneId: a.paneId, cwd: a.cwd, env: agentEnv(a), command });
    store.patch(a.id, { sessionId: a.sessionId, state: 'starting', activity: '再起動しています…', alive: true, stateSince: Date.now() });
  } else {
    const { windowId, paneId } = await tmux.createWindow({
      name: a.name.replace(/[^\w.-]+/g, '_'),
      cwd: a.cwd,
      env: agentEnv(a),
      command,
    });
    store.patch(a.id, { windowId, paneId, sessionId: a.sessionId, state: 'starting', activity: '再起動しています…', alive: true, stateSince: Date.now() });
  }
}

async function deleteAgent(a) {
  if (a.windowId) await tmux.killWindow(a.windowId).catch(() => {});
  store.remove(a.id);
}

// ---------- 監視ループ ----------

// tmux のステータス行にも状態を反映するにゃ
const tmuxState = new Map();
store.on('change', (id) => {
  const a = store.get(id);
  if (!a || !a.windowId || tmuxState.get(id) === a.state) return;
  tmuxState.set(id, a.state);
  tmux.setWindowState(a.windowId, a.state).catch(() => {});
});

// ---------- 対話要求 ----------

const reqFile = (reqId) => path.join(REQUESTS_DIR, `${reqId}.json`);
const resFile = (reqId) => path.join(RESPONSES_DIR, `${reqId}.json`);

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeResponse(reqId, data) {
  fs.mkdirSync(RESPONSES_DIR, { recursive: true });
  const tmp = `${resFile(reqId)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, resFile(reqId));
}

// 別経路（ターミナルなど）で解決された要求は、待っている hook を終わらせるにゃ
store.on('cancel', (reqId, reason) => {
  if (!reason) return; // hook 自身が終了を報告した場合にゃ
  const req = store.loadRequest(reqId);
  if (req && pidAlive(req.hookPid)) writeResponse(reqId, { result: reason, output: null });
  else fs.rmSync(reqFile(reqId), { force: true });
});

function getPendingDetail(a) {
  return a.pending.map((p) => ({ ...p, request: store.loadRequest(p.reqId) })).filter((p) => p.request);
}

function respond(a, body) {
  const p = a.pending.find((x) => x.reqId === body.reqId);
  if (!p) throw httpError(409, 'この要求はすでに解決済みです');
  const req = store.loadRequest(p.reqId);
  if (!req || !pidAlive(req.hookPid)) {
    store.dropPending(a, (x) => x === p, 'stale');
    store.changed(a.id);
    throw httpError(409, 'この要求は応答できなくなりました。ターミナルで確認してください');
  }
  const out = buildOutput(req, body);
  writeResponse(p.reqId, out);
  // hook の InteractionDone を待たずに画面から消すにゃ
  store.dropPending(a, (x) => x === p, null);
  if (out.output) store.patch(a.id, { activity: '回答を送信しました' });
  else if (!a.pending.length) store.patch(a.id, { state: 'waiting', activity: 'ターミナルでの回答待ち', stateSince: Date.now() });
  else store.changed(a.id);
}

function heartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ pid: process.pid, port: PORT, ts: Date.now() }));
  } catch {}
}

// プロセスが死んだペインを検出するにゃ（hook では拾えないクラッシュ対策にゃ）
async function reconcile() {
  const panes = await tmux.listPanes();
  for (const a of store.list()) {
    // hook が居なくなった要求は取り下げるにゃ
    if (a.pending.some((p) => !pidAlive(p.hookPid))) {
      store.dropPending(a, (p) => !pidAlive(p.hookPid), 'stale');
      store.changed(a.id);
    }
    const p = a.paneId && panes.get(a.paneId);
    const alive = !!p && !p.dead;
    if (alive !== a.alive || (!alive && a.state !== 'ended')) {
      store.patch(a.id, alive ? { alive } : { alive, state: 'ended', activity: p ? 'プロセスが終了しました' : 'ウィンドウがありません', stateSince: Date.now() });
    }
    if (p && p.windowId !== a.windowId) store.patch(a.id, { windowId: p.windowId });
  }
}

// ---------- HTTP ----------

const sseClients = new Set();
let broadcastTimer = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const data = `event: agents\ndata: ${JSON.stringify(store.list().map(publicAgent))}\n\n`;
    for (const res of sseClients) res.write(data);
  }, 80);
}
store.on('change', broadcast);

// ---------- 送信ガードとタスクキュー ----------

// 操作の受け付けは lib/queue.js が判断し、ここでは Store への反映と送信の開始だけを行います
function queueOp(a, body) {
  const { fields, sendNext } = applyQueueOp(a, body);
  store.patch(a.id, fields);
  if (sendNext) dispatchNext(a.id, { force: true }).catch((e) => console.error(e));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dispatching = new Set();
const dispatchTimers = new Map();

function readyForNext(a) {
  return a && a.alive && a.queue.length && !a.pending.length && (a.state === 'done' || a.state === 'idle') && !dispatching.has(a.id);
}

// 状態が変わるたびに、少し待ってから次のタスクを送れるか確認するにゃ
store.on('change', (id) => {
  const a = store.get(id);
  if (!a || a.queuePaused || !readyForNext(a)) return;
  clearTimeout(dispatchTimers.get(id));
  dispatchTimers.set(id, setTimeout(() => dispatchNext(id).catch((e) => console.error(e)), 1500));
});

async function dispatchNext(id, { force = false } = {}) {
  const a = store.get(id);
  if (!readyForNext(a) || (a.queuePaused && !force)) return;
  // 画面（/api/agents/:id/transcript の既定）と同じ件数を読み、仕分けボードの自動表示と同じ範囲で判定します
  const note = force ? null : proposalPauseNote(a, readTranscript(a.transcriptPath));
  if (note) {
    store.patch(id, { queuePaused: true, queueNote: note });
    return;
  }
  dispatching.add(id);
  const item = a.queue[0];
  try {
    if (item.clearFirst) {
      const before = a.lastEventAt;
      await tmux.sendText(a.paneId, '/clear');
      // /clear で SessionStart が届くのを待つにゃ
      for (let i = 0; i < 40 && store.get(id)?.lastEventAt === before; i++) await sleep(150);
      await sleep(400);
    }
    const cur = store.get(id);
    if (!cur || !cur.alive || cur.pending.length) return;
    await tmux.sendText(cur.paneId, item.text);
    const now = Date.now();
    store.patch(id, {
      queue: cur.queue.filter((x) => x.id !== item.id),
      state: 'running',
      activity: `キューから送信: ${item.text.replace(/\s+/g, ' ').slice(0, 60)}`,
      stateSince: now,
      turnStartedAt: now,
    });
  } finally {
    dispatching.delete(id);
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1 << 20) throw httpError(413, 'リクエストが大きすぎます');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw httpError(400, 'JSON が不正です');
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

async function api(req, res, url) {
  const im = url.pathname.match(IMAGE_PATH_RE);
  if (im) {
    if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
    checkImageRequest(req);
    const a = store.get(im[1]);
    if (!a) throw httpError(404, 'エージェントが見つかりません');
    // そのエージェントの transcript にある画像だけを、参照から引いて返します
    const img = readTranscriptImage(a.transcriptPath, im[2]);
    if (!img) throw httpError(404, '画像が見つかりません');
    return sendImage(res, img);
  }

  const m = url.pathname.match(/^\/api\/agents(?:\/([\w-]+)(?:\/(\w+))?)?$/);

  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: agents\ndata: ${JSON.stringify(store.list().map(publicAgent))}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  if (url.pathname === '/api/info') {
    return send(res, 200, { tmuxSession: TMUX_SESSION, defaultModel: DEFAULT_MODEL, workspaces: WORKSPACES_DIR, hubHome: HUB_HOME });
  }

  if (!m) throw httpError(404, 'Not found');
  const [, id, action] = m;

  if (!id) {
    if (req.method === 'GET') return send(res, 200, store.list().map(publicAgent));
    if (req.method === 'POST') return send(res, 201, publicAgent(await createAgent(await readJson(req))));
    throw httpError(405, 'Method not allowed');
  }

  const a = store.get(id);
  if (!a) throw httpError(404, 'エージェントが見つかりません');

  if (!action) {
    if (req.method === 'GET') return send(res, 200, publicAgent(a));
    if (req.method === 'DELETE') {
      await deleteAgent(a);
      return send(res, 200, { ok: true });
    }
    throw httpError(405, 'Method not allowed');
  }

  if (req.method === 'GET' && action === 'transcript') {
    return send(res, 200, { items: readTranscript(a.transcriptPath, Number(url.searchParams.get('limit')) || 300) });
  }
  if (req.method === 'GET' && action === 'pending') {
    return send(res, 200, { items: getPendingDetail(a) });
  }
  if (req.method === 'GET' && action === 'screen') {
    if (!a.alive) return send(res, 200, { text: '' });
    return send(res, 200, { text: await tmux.capturePane(a.paneId).catch(() => '') });
  }
  if (req.method !== 'POST') throw httpError(405, 'Method not allowed');

  const body = await readJson(req);
  switch (action) {
    case 'send': {
      const text = String(body.text ?? '');
      if (!text.trim()) throw httpError(400, 'メッセージが空です');
      const blocked = sendBlockReason(a);
      if (blocked) throw Object.assign(httpError(409, blocked), { code: 'blocked' });
      await tmux.sendText(a.paneId, text);
      return send(res, 200, { ok: true });
    }
    case 'queue':
      queueOp(a, body);
      return send(res, 200, { ok: true, queue: store.get(a.id).queue });
    case 'keys': {
      if (!a.alive) throw httpError(409, 'エージェントは停止しています');
      await tmux.sendKey(a.paneId, String(body.key));
      // 実行中の Esc / Ctrl+C は中断扱いにするにゃ（中断では Stop hook が来ないため）
      if ((body.key === 'Escape' || body.key === 'C-c') && a.state === 'running') {
        // 中断した直後に次のキューが流れないよう一時停止もするにゃ
        const paused = a.queue.length ? { queuePaused: true, queueNote: INTERRUPT_PAUSE_NOTE } : {};
        store.patch(a.id, { state: 'idle', activity: '中断しました', stateSince: Date.now(), ...paused });
      }
      return send(res, 200, { ok: true });
    }
    case 'respond':
      respond(a, body);
      return send(res, 200, { ok: true });
    case 'restart':
      await restartAgent(a);
      return send(res, 200, { ok: true });
    case 'focus':
      await tmux.focusWindow(a.windowId);
      return send(res, 200, { ok: true });
    default:
      throw httpError(404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    checkRequest(req);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET') serveStatic(res, url.pathname);
    else throw httpError(405, 'Method not allowed');
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message, ...(e.code && typeof e.code === 'string' && e.status ? { code: e.code } : {}) });
    if (!e.status) console.error(e);
  }
});

// ---------- 起動 ----------

writeHooksFile();
store.init();
await reconcile();
// 復元した状態を tmux のステータス行にも反映するにゃ
for (const a of store.list()) store.changed(a.id);

fs.watch(EVENTS_DIR, (_type, fname) => {
  if (fname && fname.endsWith('.jsonl')) store.ingest(fname.slice(0, -'.jsonl'.length));
});
// fs.watch の取りこぼし対策の保険にゃ
setInterval(() => store.list().forEach((a) => store.ingest(a.id)), 1500);
setInterval(() => reconcile().catch(() => {}), 2000);

// 終了時は待機中の hook をすべて解放して TUI に任せるにゃ
function shutdown() {
  for (const a of store.list()) store.dropPending(a, () => true, 'server-stopped');
  fs.rmSync(HEARTBEAT_FILE, { force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  heartbeat();
  setInterval(heartbeat, 5000);
  console.log(`Agent Hub: http://localhost:${PORT}`);
  console.log(`  tmux session : ${TMUX_SESSION}  (tmux attach -t ${TMUX_SESSION})`);
  console.log(`  data dir     : ${HUB_HOME}`);
});
