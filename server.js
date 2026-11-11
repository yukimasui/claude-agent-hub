// Agent Hub のサーバです。外部依存なしの Node 標準モジュールだけで動きます
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  CLAUDE_BIN,
  CONTEXT_WARN_TOKENS,
  DEFAULT_MODEL,
  EVENTS_DIR,
  HANDOFFS_DIR,
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
import { HANDOFF_PAUSE_NOTE, INTERRUPT_PAUSE_NOTE, applyQueueOp, clearFinished, clearPauseNote, proposalPauseNote, sendBlockReason } from './lib/queue.js';
import { buildMemoPrompt, buildResumePrompt, formatMemoFile, handoffStep, memoFileName, parseMemoFile, queueRestoreFields } from './lib/handoff.js';
import { handoffBlockReason, isHandoffActive } from './public/handoff.js';
import * as tmux from './lib/tmux.js';
import { readContextTokens, readTranscript, readTranscriptImage } from './lib/transcript.js';
import { listSubagents, notificationsCaughtUp, readSubagentTranscript } from './lib/subagents.js';
import { IMAGE_PATH_RE, checkImageRequest, checkRequest, httpError, listen, listenErrorMessage, sendImage, serveStatic } from './lib/http.js';
import { watchDir } from './lib/watch.js';

const store = new Store();

// ---------- 起動準備 ----------

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** --settings で渡す hook 設定を生成します。グローバル設定は汚しません */
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

// 空文字はユーザー設定に従います（フラグを渡しません）
const PERMISSION_MODES = new Set(['manual', 'acceptEdits', 'auto', 'plan']);
// ステータス表示の猫の毛色です（空文字はおまかせ）
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
  const base = { id, name, model, cwd, permissionMode, coat, sessionId: randomUUID(), createdAt: Date.now(), processStartedAt: Date.now() };
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
  // 会話が始まっていれば resume、まだなら新しいセッションで起動します
  // processStartedAt は、前のプロセスで止まったサブエージェントを「中断」と判定するために更新します（SessionStart が届けば上書きされます）
  const resume = !!(a.transcriptPath && fs.existsSync(a.transcriptPath));
  if (!resume) a.sessionId = randomUUID();
  const command = buildCommand(a, { resume });
  const panes = await tmux.listPanes();
  if (a.paneId && panes.has(a.paneId)) {
    await tmux.respawnPane({ paneId: a.paneId, cwd: a.cwd, env: agentEnv(a), command });
    store.patch(a.id, { sessionId: a.sessionId, state: 'starting', activity: '再起動しています…', alive: true, stateSince: Date.now(), processStartedAt: Date.now() });
  } else {
    const { windowId, paneId } = await tmux.createWindow({
      name: a.name.replace(/[^\w.-]+/g, '_'),
      cwd: a.cwd,
      env: agentEnv(a),
      command,
    });
    store.patch(a.id, { windowId, paneId, sessionId: a.sessionId, state: 'starting', activity: '再起動しています…', alive: true, stateSince: Date.now(), processStartedAt: Date.now() });
  }
}

async function deleteAgent(a) {
  if (a.windowId) await tmux.killWindow(a.windowId).catch(() => {});
  store.remove(a.id);
}

// ---------- 監視ループ ----------

// tmux のステータス行にも状態を反映します
const tmuxState = new Map();
store.on('change', (id) => {
  const a = store.get(id);
  if (!a || !a.windowId || tmuxState.get(id) === a.state) return;
  tmuxState.set(id, a.state);
  tmux.setWindowState(a.windowId, a.state).catch(() => {});
});

// ---------- サブエージェント ----------

// サブエージェントの一覧は記録ファイルから組み立て、内容が変わったときだけエージェントの情報を更新して画面に配信します。
// 状態が変わるたび（サブエージェント内のツール呼び出しも hook のイベントとして届きます）と、
// イベントが届かない変化（親のプロセスの終了など）に備えた定期的な確認のときに組み立て直します。
const subagentSig = new Map();
const refreshingSubagents = new Set();
function refreshSubagents(id) {
  const a = store.get(id);
  if (!a || refreshingSubagents.has(id)) return;
  refreshingSubagents.add(id);
  try {
    const subagents = listSubagents(a);
    const sig = JSON.stringify(subagents);
    if (sig === subagentSig.get(id)) return;
    subagentSig.set(id, sig);
    store.patch(id, { subagents });
  } catch (e) {
    console.error(e);
  } finally {
    refreshingSubagents.delete(id);
  }
}
store.on('change', (id) => {
  if (!store.get(id)) subagentSig.delete(id);
  else refreshSubagents(id);
});

// ---------- コンテキスト量 ----------

// transcript の最新の応答から求め、変わったときだけエージェントの情報を更新して画面に配信します
function refreshContext(id) {
  const a = store.get(id);
  if (!a) return;
  const tokens = readContextTokens(a.transcriptPath);
  if (tokens !== a.contextTokens) store.patch(id, { contextTokens: tokens });
}
store.on('change', (id) => refreshContext(id));

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

// 別経路（ターミナルなど）で解決された要求は、待っている hook を終わらせます
store.on('cancel', (reqId, reason) => {
  if (!reason) return; // hook 自身が終了を報告した場合です
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
  // hook の InteractionDone を待たずに画面から消します
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

// プロセスが死んだペインを検出します（hook では拾えないクラッシュへの対策です）
async function reconcile() {
  const panes = await tmux.listPanes();
  for (const a of store.list()) {
    // hook が居なくなった要求は取り下げます
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
  // 引き継ぎの間は、一時停止の状態にかかわらず送りません（メモの応答や新しいセッションの最初の指示の前に割り込ませないため）
  return a && a.alive && a.queue.length && !a.pending.length && (a.state === 'done' || a.state === 'idle') && !dispatching.has(a.id) && !isHandoffActive(a.handoff);
}

// 状態が変わるたびに、少し待ってから次のタスクを送れるか確認します
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
  const before = a.sessionId;
  try {
    if (item.clearFirst) {
      await tmux.sendText(a.paneId, '/clear');
      // /clear で新しいセッションの SessionStart が届くのを待ちます（判定は lib/queue.js の clearFinished）
      for (let i = 0; i < 40 && !clearFinished(before, store.get(id)); i++) await sleep(150);
      await sleep(400);
    }
    const cur = store.get(id);
    // 新しいセッションを確認できなかった場合は、リセットされていない会話に本文を送らないよう、項目を残して一時停止します
    // （判定と再開時の動きは lib/queue.js の clearPauseNote と CLEAR_UNCONFIRMED_PAUSE_NOTE）
    const clearNote = item.clearFirst ? clearPauseNote(before, cur) : null;
    if (clearNote) {
      store.patch(id, { queuePaused: true, queueNote: clearNote });
      return;
    }
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

// ---------- 引き継いでリセット ----------

// 段階を進める処理を実行中のエージェントです。tmux への送信を待つ間に、状態の変化で同じ段階を二重に進めないようにします
const handoffBusy = new Set();

/** 引き継ぎを始めます。キューを一時停止し、引き継ぎメモを応答として書くよう指示します */
async function startHandoff(a) {
  const reason =
    handoffBlockReason(a) ||
    (dispatching.has(a.id) || handoffBusy.has(a.id) ? 'キューの送信中です。少し待ってから実行してください' : null) ||
    (!fs.existsSync(a.transcriptPath) ? 'まだ会話がありません' : null);
  if (reason) throw httpError(409, reason);
  clearTimeout(dispatchTimers.get(a.id));
  const marker = `handoff-${randomBytes(4).toString('hex')}`;
  const sentAt = Date.now();
  // 指示を送り終えるまでは段階を進めないよう、段階を保存する前から処理中にしておきます
  handoffBusy.add(a.id);
  // 段階を保存してから指示を送ります。送った後にサーバが止まっても、再起動後に同じ段階から判定を続けられるようにするためです
  store.patch(a.id, {
    handoff: { stage: 'memo', marker, fromSession: a.sessionId, startedAt: sentAt, sentAt, prevPaused: a.queuePaused, prevNote: a.queueNote },
    queuePaused: true,
    queueNote: HANDOFF_PAUSE_NOTE,
  });
  try {
    await tmux.sendText(a.paneId, buildMemoPrompt(marker));
  } catch (e) {
    finishHandoff(a.id, 'failed', `引き継ぎメモの指示を送れませんでした: ${e.message}（/clear は送っていません）`);
    throw httpError(500, `引き継ぎメモの指示を送れませんでした: ${e.message}`);
  } finally {
    handoffBusy.delete(a.id);
  }
  const cur = store.get(a.id);
  // 送信を待つ間に状態が変わっていなければ、UserPromptSubmit を待たずに「実行中」にします（キューの送信と同じ扱いです）
  if (cur && isHandoffActive(cur.handoff) && cur.stateSince < sentAt) {
    const now = Date.now();
    store.patch(a.id, { state: 'running', activity: '引き継ぎメモを作成しています…', stateSince: now, turnStartedAt: now });
  }
}

/** 引き継ぎを終え、キューの一時停止を元に戻します。結果（完了・中止とその理由）は画面で閉じるまで残します */
function finishHandoff(id, stage, message, extra = {}) {
  const a = store.get(id);
  if (!a?.handoff) return;
  const { stage: _s, marker, prevPaused, prevNote, ...rest } = a.handoff;
  store.patch(id, { ...queueRestoreFields(a), ...extra, handoff: { ...rest, stage, message: message || '', finishedAt: Date.now() } });
}

/** 引き継ぎメモを保存し、保存先のパスを返します */
function saveMemo(a, memo) {
  fs.mkdirSync(HANDOFFS_DIR, { recursive: true });
  const createdAt = Date.now();
  const file = path.join(HANDOFFS_DIR, memoFileName(a.id, createdAt));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, formatMemoFile({ id: a.id, name: a.name, cwd: a.cwd, sessionId: a.sessionId, createdAt }, memo));
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 状態の変化と定期的な確認のたびに呼び、引き継ぎの段階を進めます。何をするかは lib/handoff.js の handoffStep が決めます。
 * /clear は、メモを保存して段階を clear に進めたことを保存してから送ります。サーバが止まっても、メモのないまま /clear だけが送られた状態にならないためです。
 */
async function advanceHandoff(id) {
  const a = store.get(id);
  if (!a || !isHandoffActive(a.handoff) || handoffBusy.has(id)) return;
  handoffBusy.add(id);
  try {
    const step = handoffStep(a, { now: Date.now(), readItems: () => readTranscript(a.transcriptPath) });
    switch (step.type) {
      case 'fail':
        finishHandoff(id, 'failed', step.reason);
        break;
      case 'clear': {
        const file = saveMemo(a, step.memo);
        store.patch(id, { handoff: { ...a.handoff, stage: 'clear', memoFile: file, clearSentAt: Date.now() }, activity: '/clear で会話をリセットしています…' });
        try {
          await tmux.sendText(a.paneId, '/clear');
        } catch (e) {
          finishHandoff(id, 'failed', `/clear を送れませんでした: ${e.message}（メモは ${file} に保存しています）`);
        }
        break;
      }
      case 'resume': {
        const file = a.handoff.memoFile;
        let memo;
        try {
          memo = parseMemoFile(fs.readFileSync(file, 'utf8'));
        } catch (e) {
          finishHandoff(id, 'failed', `保存したメモを読めませんでした: ${e.message}`);
          break;
        }
        try {
          await tmux.sendText(a.paneId, buildResumePrompt(memo, file));
        } catch (e) {
          finishHandoff(id, 'failed', `新しいセッションに再開の指示を送れませんでした: ${e.message}（メモは ${file} に保存しています）`);
          break;
        }
        const now = Date.now();
        finishHandoff(id, 'done', `メモは ${file} に保存しています`, { state: 'running', activity: '引き継ぎメモを付けて再開しました', stateSince: now, turnStartedAt: now });
        break;
      }
      case 'finish':
        finishHandoff(id, 'done', step.note);
        break;
    }
  } catch (e) {
    console.error(e);
    // メモの保存に失敗した場合などです。段階が clear に進む前であれば /clear は送っていません
    const cur = store.get(id);
    if (isHandoffActive(cur?.handoff)) finishHandoff(id, 'failed', `引き継ぎを続けられませんでした: ${e.message}${cur.handoff.stage === 'memo' ? '（/clear は送っていません）' : ''}`);
  } finally {
    handoffBusy.delete(id);
  }
}
store.on('change', (id) => {
  if (isHandoffActive(store.get(id)?.handoff)) advanceHandoff(id).catch((e) => console.error(e));
});

function handoffOp(a, body) {
  if (body.op === 'start') return startHandoff(a);
  if (body.op === 'dismiss') {
    if (isHandoffActive(a.handoff)) throw httpError(409, '引き継いでリセットを実行中です');
    store.patch(a.id, { handoff: null });
    return;
  }
  throw httpError(400, `不明な操作です: ${body.op}`);
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

  // サブエージェントの会話（読み取り専用）です。読めるのはそのエージェントのセッションの subagents/ にある記録だけです
  const sm = url.pathname.match(/^\/api\/agents\/([\w-]+)\/subagents\/([\w-]{1,64})\/transcript$/);
  if (sm) {
    if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
    const a = store.get(sm[1]);
    if (!a) throw httpError(404, 'エージェントが見つかりません');
    const items = readSubagentTranscript(a, sm[2], Number(url.searchParams.get('limit')) || 300);
    if (!items) throw httpError(404, 'サブエージェントが見つかりません');
    return send(res, 200, { items });
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
    return send(res, 200, { tmuxSession: TMUX_SESSION, defaultModel: DEFAULT_MODEL, workspaces: WORKSPACES_DIR, hubHome: HUB_HOME, contextWarnTokens: CONTEXT_WARN_TOKENS });
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
      // 実行中の Esc / Ctrl+C は中断扱いにします（中断では Stop hook が来ないため）
      if ((body.key === 'Escape' || body.key === 'C-c') && a.state === 'running') {
        // 中断した直後に次のキューが流れないよう一時停止もします
        const paused = a.queue.length ? { queuePaused: true, queueNote: INTERRUPT_PAUSE_NOTE } : {};
        store.patch(a.id, { state: 'idle', activity: '中断しました', stateSince: Date.now(), ...paused });
      }
      return send(res, 200, { ok: true });
    }
    case 'respond':
      respond(a, body);
      return send(res, 200, { ok: true });
    case 'handoff':
      await handoffOp(a, body);
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
    else if (req.method === 'GET') serveStatic(req, res, PUBLIC_DIR, url.pathname);
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
// 復元した状態を tmux のステータス行にも反映します
for (const a of store.list()) store.changed(a.id);

// 監視が止まっても（フォルダが消された、監視の上限に達したなど）落ちずに張り直します。張り直せない間も下の定期的な読み直しで状態の更新は続きます
watchDir(EVENTS_DIR, (_type, fname) => {
  if (fname && fname.endsWith('.jsonl')) store.ingest(fname.slice(0, -'.jsonl'.length));
});
// fs.watch の取りこぼし対策の保険です
setInterval(() => store.list().forEach((a) => store.ingest(a.id)), 1500);
setInterval(() => reconcile().catch(() => {}), 2000);
// 引き継ぎの待ち時間の上限と、Stop の後に transcript へメモが書き込まれるのを待つ間は、イベントが届かなくても判定し直します。
// コンテキスト量も、イベントの後に transcript へ書き込まれた応答を取りこぼさないよう定期的に確かめます（追記分だけを読みます）
setInterval(() => {
  for (const a of store.list()) {
    refreshContext(a.id);
    if (isHandoffActive(a.handoff)) advanceHandoff(a.id).catch((e) => console.error(e));
  }
}, 1000);
// プロセスが終了したエージェントのサブエージェントは記録が増えないため、完了通知を読み終えていれば定期的な確認を省きます
// （親の状態が変わったときは 'change' で組み立て直します）
setInterval(() => {
  for (const a of store.list()) if (a.alive || !notificationsCaughtUp(a.transcriptPath)) refreshSubagents(a.id);
}, 3000);

// 終了時は待機中の hook をすべて解放して TUI に任せます
function shutdown() {
  for (const a of store.list()) store.dropPending(a, () => true, 'server-stopped');
  fs.rmSync(HEARTBEAT_FILE, { force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await listen(server, PORT, HOST);
} catch (e) {
  // ポートが使用中などで待ち受けられない場合は、原因が分かるメッセージを表示して終了します。
  // 同じデータ置き場で別のハブが動いている場合に、そのハブの心拍ファイルや回答待ちの hook に触れないよう、shutdown は呼びません
  console.error(`Agent Hub を起動できません: ${listenErrorMessage(e, PORT, HOST)}`);
  process.exit(1);
}
// 待ち受けを始めた後の error（接続の受け付けの失敗など）は、受けないとサーバ全体が落ちるため、記録したうえで動作を続けます
server.on('error', (e) => console.error('HTTP サーバでエラーが発生しました:', e));
heartbeat();
setInterval(heartbeat, 5000);
console.log(`Agent Hub: http://localhost:${PORT}`);
console.log(`  tmux session : ${TMUX_SESSION}  (tmux attach -t ${TMUX_SESSION})`);
console.log(`  data dir     : ${HUB_HOME}`);
