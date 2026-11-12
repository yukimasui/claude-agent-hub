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
  STATUSLINE_SCRIPT,
  TMUX_SESSION,
  TOOL_EVENTS,
  USAGE_FILE,
  WORKSPACES_DIR,
} from './lib/config.js';
import { Store, publicAgent } from './lib/store.js';
import { buildOutput } from './lib/interactions.js';
import {
  HANDOFF_PAUSE_NOTE,
  INTERRUPT_PAUSE_NOTE,
  applyQueueOp,
  clearFinished,
  dispatchSendStep,
  dispatchStartStep,
  exitWatchPatch,
  localCommandPatch,
  mayBeLocalCommand,
  readyForNext,
  sendBlockReason,
} from './lib/queue.js';
import { buildMemoPrompt, buildResumePrompt, formatMemoFile, handoffStep, memoFileName, parseMemoFile, queueRestoreFields } from './lib/handoff.js';
import { handoffBlockReason, isHandoffActive } from './public/handoff.js';
import { effortChangeBlockReason, effortToFollow } from './public/effort.js';
import { EXIT_COMMAND, EXITING_REASON, exitBlockReason } from './public/exit.js';
import { buildCommand as buildLaunchCommand, effortOption, requestedEffort, shq } from './lib/launch.js';
import * as tmux from './lib/tmux.js';
import { resolvePanes } from './lib/panes.js';
import { readContextTokens, readEffortChange, readLocalCommandOutputAt, readTranscript, readTranscriptImage } from './lib/transcript.js';
import { listSubagents, notificationsCaughtUp, readSubagentTranscript } from './lib/subagents.js';
import { IMAGE_PATH_RE, checkImageRequest, checkRequest, httpError, listen, listenErrorMessage, sendImage, serveStatic } from './lib/http.js';
import { watchDir } from './lib/watch.js';
import { usageReader } from './lib/usage.js';

const store = new Store();

// ---------- 起動準備 ----------

/**
 * --settings で渡す hook 設定を生成します。グローバル設定は汚しません。
 * statusLine は、利用上限の使用率（rate_limits）を受け取るために加えます。利用者や作業ディレクトリの設定にある
 * ステータスラインは、スクリプトが同じ入力で実行して表示を引き継ぎます（hooks/statusline.cjs）
 */
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
  const statusLine = { type: 'command', command: `${shq(process.execPath)} ${shq(STATUSLINE_SCRIPT)}` };
  fs.writeFileSync(HOOKS_FILE, JSON.stringify({ hooks, statusLine }, null, 2));
}

// 組み立ては lib/launch.js が行い、ここでは設定値を渡します
function buildCommand(a, { resume = false, prompt } = {}) {
  return buildLaunchCommand(a, { bin: CLAUDE_BIN, settingsFile: HOOKS_FILE, systemPrompt: HUB_SYSTEM_PROMPT, resume, prompt });
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
  // 空文字はユーザー設定に従い、--effort を付けません（lib/launch.js の effortOption）
  const effort = effortOption(body.effort);
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
  const base = { id, name, model, cwd, permissionMode, effort, coat, sessionId: randomUUID(), createdAt: Date.now(), processStartedAt: Date.now() };
  const prompt = String(body.prompt || '').trim();
  const { windowId, paneId } = await tmux.createWindow({
    agentId: id,
    name: name.replace(/[^\w.-]+/g, '_'),
    cwd,
    env: agentEnv(base),
    command: buildCommand(base, { prompt }),
  });
  return store.add({ ...base, windowId, paneId });
}

// 起動し直している最中のエージェントです。tmux の操作を待つ間に、キューの自動送信が古いプロセスや起動途中のプロセスへ送らないようにします
const restarting = new Set();

async function restartAgent(a, { activity = '再起動しています…' } = {}) {
  restarting.add(a.id);
  clearTimeout(dispatchTimers.get(a.id));
  try {
    await respawnAgent(a, activity);
  } finally {
    restarting.delete(a.id);
  }
}

async function respawnAgent(a, activity) {
  // 会話が始まっていれば resume、まだなら新しいセッションで起動します
  // processStartedAt は、前のプロセスで止まったサブエージェントを「中断」と判定するために更新します（SessionStart が届けば上書きされます）
  const resume = !!(a.transcriptPath && fs.existsSync(a.transcriptPath));
  if (!resume) a.sessionId = randomUUID();
  const command = buildCommand(a, { resume });
  // 覚えているペイン ID が別のエージェントのペインに使われている場合に、そのプロセスを終了させないよう、持ち主を確かめてから使います
  const owned = resolvePanes(store.list(), await tmux.listPanes()).get(a.id)?.pane;
  if (owned) {
    await tmux.respawnPane({ agentId: a.id, paneId: a.paneId, cwd: a.cwd, env: agentEnv(a), command });
    store.patch(a.id, { sessionId: a.sessionId, state: 'starting', activity, alive: true, stateSince: Date.now(), processStartedAt: Date.now(), exitSentAt: null });
  } else {
    const { windowId, paneId } = await tmux.createWindow({
      agentId: a.id,
      name: a.name.replace(/[^\w.-]+/g, '_'),
      cwd: a.cwd,
      env: agentEnv(a),
      command,
    });
    store.patch(a.id, { windowId, paneId, sessionId: a.sessionId, state: 'starting', activity, alive: true, stateSince: Date.now(), processStartedAt: Date.now(), exitSentAt: null });
  }
}

/**
 * 作成済みのエージェントのエフォートを変更します。変更できるかどうかは public/effort.js の effortChangeBlockReason が決めます。
 * 動いているエージェントは、保存値を更新してから --resume で起動し直し、新しい --effort を付けて反映します（会話の記録がまだなければ新しいセッションです）。
 * ハブから /effort を送らないのは、/effort が利用者の設定（~/.claude/settings.json のモデルごとの既定）にも保存するためです。
 * プロセスが終了しているときは保存値だけを更新し、次の再起動で反映します。
 * effortSetAt は、ハブから変えた時刻です。これより前に TUI で実行された /effort を、後から読み直して値を戻さないようにします（refreshEffort）
 */
async function changeEffort(a, body) {
  const effort = requestedEffort(body);
  if (effort === (a.effort || '')) return { restarted: false };
  const reason =
    effortChangeBlockReason(a) ||
    (a.alive && (dispatching.has(a.id) || restarting.has(a.id) || handoffBusy.has(a.id)) ? 'キューの送信中か、起動し直している最中です。少し待ってから変更してください' : null) ||
    // 終わりかけのプロセスを起動し直すと、送った /exit と起動し直しのどちらが効くかが読めないため、終わるのを待ってもらいます
    (a.alive && a.exitSentAt ? EXITING_REASON : null);
  if (reason) throw httpError(409, reason);
  // 保存値を先に更新します。起動し直しに失敗しても、次の再起動で新しい値が使われるようにするためです
  store.patch(a.id, { effort, effortSetAt: Date.now() });
  if (!a.alive) return { restarted: false };
  await restartAgent(a, { activity: `エフォートを「${effort || 'ユーザー設定に従う'}」にして起動し直しています…` });
  return { restarted: true };
}

/**
 * 動いているエージェントに /exit を送って終了させます。送れるかどうかは public/exit.js の exitBlockReason が決め、
 * ここではキューの送信中・起動し直しの最中・引き継ぎの段階の実行中といった、サーバだけが知っている状態を確かめます。
 * tmux のウィンドウは remain-on-exit でペインが残るため、プロセスが終わると生存確認（reconcile）で「終了」になり、
 * 後から「再起動」で同じペインに起動し直せます。
 * exitSentAt（送った時刻）は、プロセスが終わるまでキューの自動送信を止める印です（isBusy）。
 * 終わったときと、待っても終わらなかったときの外し方は lib/queue.js の exitWatchPatch が決めます（settleExit）
 */
async function exitAgent(a) {
  const reason =
    exitBlockReason(a) ||
    (dispatching.has(a.id) || restarting.has(a.id) || handoffBusy.has(a.id) ? 'キューの送信中か、起動し直している最中です。少し待ってから終了してください' : null);
  if (reason) throw httpError(409, reason);
  clearTimeout(dispatchTimers.get(a.id));
  // 送る前に印を付けます。送信を待つ間に状態が変わっても、キューの自動送信が次の項目を送らないようにするためです
  store.patch(a.id, { exitSentAt: Date.now(), activity: '終了しています…' });
  try {
    await tmux.sendText(a.paneId, EXIT_COMMAND, a.id);
  } catch (e) {
    // 送れなかった場合は印を外し、キューの自動送信が止まったままにならないようにします
    store.patch(a.id, { exitSentAt: null, activity: `終了を指示できませんでした: ${e.message}` });
    throw e;
  }
}

/** 終了を送ったエージェントの印を、プロセスが終わったか、待っても終わらなかったときに外します（判定は lib/queue.js の exitWatchPatch） */
function settleExit(id) {
  const fields = exitWatchPatch(store.get(id), Date.now());
  if (fields) store.patch(id, fields);
}

/**
 * エージェントを削除します。ウィンドウが別のエージェント（またはハブのものではないウィンドウ）に使われていれば閉じずに記録だけを削除し、
 * そのことを応答に含めるための文を返します（閉じたか、閉じるウィンドウがなければ null）。
 * ウィンドウを閉じられなくても記録の削除は続けます。記録の削除は別のエージェントに影響せず、利用者の求めた操作を果たせるためです
 */
async function deleteAgent(a) {
  let note = null;
  if (a.windowId) {
    await tmux.killWindow(a.windowId, a.id).catch((e) => {
      if (e.code !== 'foreign-pane') return;
      note = `${e.message}。エージェントの記録は削除しました`;
      console.warn(`エージェント ${a.id}（${a.name}）を削除しました。ウィンドウ ${a.windowId} は別のエージェント（またはハブのものではないウィンドウ）に使われているため、閉じていません`);
    });
  }
  store.remove(a.id);
  return note;
}

// ---------- 監視ループ ----------

// tmux のステータス行にも状態を反映します。
// 書き込む前に持ち主を確かめるため、状態が変わるたびに書き込むとそのたびにペインの一覧を取ることになります。
// そこで lib/tmux.js の windowStateWriter で、少し待ってからまとめて書き込みます。生存確認（reconcile）が一覧を取った直後は、その一覧を使います
const statusWriter = tmux.windowStateWriter((id) => {
  const a = store.get(id);
  return a && a.windowId ? { windowId: a.windowId, state: a.state, agentId: a.id } : null;
});
store.on('change', (id) => statusWriter.mark(id));

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

// ---------- エフォートの追従 ----------

// TUI で直接実行された /effort の結果を transcript から読み、保存値に反映します
// （読み取りは lib/transcript.js の readEffortChange、反映するかどうかは public/effort.js の effortToFollow が決めます）
function refreshEffort(id) {
  const a = store.get(id);
  if (!a) return;
  const effort = effortToFollow(a, readEffortChange(a.transcriptPath));
  if (effort !== undefined) store.patch(id, { effort });
}
store.on('change', (id) => refreshEffort(id));

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
  // ペイン ID は tmux のサーバーが変わると使い回されるため、ID があるかどうかではなく、そのエージェントのペインかどうかで判定します
  const resolved = resolvePanes(store.list(), panes);
  for (const a of store.list()) {
    // hook が居なくなった要求は取り下げます
    if (a.pending.some((p) => !pidAlive(p.hookPid))) {
      store.dropPending(a, (p) => !pidAlive(p.hookPid), 'stale');
      store.changed(a.id);
    }
    const { pane: p, foreign } = resolved.get(a.id) ?? { pane: null, foreign: false };
    const alive = !!p && !p.dead;
    // 別のエージェントのウィンドウを指している ID は消します。削除・「tmux で表示」・ステータス行の更新などが別のウィンドウに効かないようにするためです。
    // 状態の更新と同じ patch で消すのは、状態の変化を受けたステータス行の更新が、消す前の ID で別のウィンドウに書き込まないようにするためです
    const clearIds = foreign ? { paneId: null, windowId: null } : {};
    if (alive !== a.alive || (!alive && a.state !== 'ended')) {
      store.patch(a.id, alive ? { alive } : { alive, state: 'ended', activity: p ? 'プロセスが終了しました' : 'ウィンドウがありません', stateSince: Date.now(), ...clearIds });
    } else if (foreign) store.patch(a.id, clearIds);
    if (p && p.windowId !== a.windowId) store.patch(a.id, { windowId: p.windowId });
  }
  // 「終了」にした分などのステータス行は、取ったばかりの一覧で持ち主を確かめて書き込み、一覧を取り直さずに済ませます
  await statusWriter.flush(panes);
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

// 利用上限の使用率です。エージェントの一覧とは別のイベントにし、変わったときだけ配ります
const usage = usageReader(USAGE_FILE);
const usageEvent = () => `event: usage\ndata: ${JSON.stringify(usage.current())}\n\n`;
function refreshUsage() {
  if (!usage.refresh()) return;
  const data = usageEvent();
  for (const res of sseClients) res.write(data);
}

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

// 送れる状態かどうかは lib/queue.js の readyForNext が決め、ここでは送信中・起動し直し中・終了を待っている最中かどうかだけを渡します。
// 終了を待っている間は、/exit の後に入力した項目が終わりかけの TUI に入って失われないよう送りません
const isBusy = (id) => dispatching.has(id) || restarting.has(id) || !!store.get(id)?.exitSentAt;

// 状態が変わるたびに、少し待ってから次のタスクを送れるか確認します
store.on('change', (id) => {
  const a = store.get(id);
  if (!a || a.queuePaused || !readyForNext(a, { busy: isBusy(id) })) return;
  clearTimeout(dispatchTimers.get(id));
  dispatchTimers.set(id, setTimeout(() => dispatchNext(id).catch((e) => console.error(e)), 1500));
});

async function dispatchNext(id, { force = false } = {}) {
  const a = store.get(id);
  // 送るかどうか・一時停止するかどうかは lib/queue.js の dispatchStartStep と dispatchSendStep が決めます
  // 会話は画面（/api/agents/:id/transcript の既定）と同じ件数を読み、仕分けボードの自動表示と同じ範囲で判定します
  const start = dispatchStartStep(a, { force, busy: isBusy(id), readItems: () => readTranscript(a.transcriptPath) });
  if (start.type === 'pause') store.patch(id, { queuePaused: true, queueNote: start.note });
  if (start.type !== 'send') return;
  dispatching.add(id);
  const { item } = start;
  const before = a.sessionId;
  let sent = null;
  try {
    if (item.clearFirst) {
      await tmux.sendText(a.paneId, '/clear', a.id);
      // /clear で新しいセッションの SessionStart が届くのを待ちます（判定は lib/queue.js の clearFinished）
      for (let i = 0; i < 40 && !clearFinished(before, store.get(id)); i++) await sleep(150);
      await sleep(400);
    }
    const cur = store.get(id);
    // 新しいセッションを確認できなかった場合は、リセットされていない会話に本文を送らないよう、項目を残して一時停止します
    // （判定と再開時の動きは lib/queue.js の dispatchSendStep・clearPauseNote と CLEAR_UNCONFIRMED_PAUSE_NOTE）
    const step = dispatchSendStep(item, before, cur);
    if (step.type === 'pause') store.patch(id, { queuePaused: true, queueNote: step.note });
    if (step.type !== 'send') return;
    const sentAt = Date.now();
    await tmux.sendText(cur.paneId, item.text, id);
    const now = Date.now();
    const activity = `キューから送信: ${item.text.replace(/\s+/g, ' ').slice(0, 60)}`;
    if (mayBeLocalCommand(item.text)) sent = { at: sentAt, stateSince: now, turnStartedAt: now, sessionId: cur.sessionId, command: item.text.split(/\s/)[0], activity };
    // 見守りの情報（localCommandWatch）は「実行中」にするのと同じ patch で保存します。見守りの途中でハブが止まっても、
    // 再起動後に「実行中」へ戻して続きから見守れるようにするためです（lib/store.js の ingest、下の起動の処理）。
    // スラッシュコマンドでなければ null にし、前の見守りの情報が残らないようにします
    store.patch(id, {
      queue: cur.queue.filter((x) => x.id !== item.id),
      state: 'running',
      activity,
      stateSince: now,
      turnStartedAt: now,
      localCommandWatch: sent,
    });
  } finally {
    dispatching.delete(id);
  }
  // 送信中の印を外してから見守ります。「待機中」に戻したときの状態の変化で、次の項目の自動送信を判定させるためです
  // （見守っている間は「実行中」のままなので、次の項目が先に送られることはありません）
  if (sent) await watchLocalCommand(id, sent);
}

// キューから送ったスラッシュコマンドが、TUI の中だけで処理されるローカルコマンドだったかを見守り、
// そうであれば「実行中」から戻します。ローカルコマンドでは Stop などの hook のイベントが届かず、「実行中」のまま止まるためです。
// 判定は lib/queue.js の localCommandPatch、終わったことの確認は transcript の出力の記録（lib/transcript.js の readLocalCommandOutputAt）で行います
async function watchLocalCommand(id, sent) {
  for (;;) {
    await sleep(300);
    // 監視の通知を待たずにイベントを読み込みます。プロンプトとして展開されたコマンドの UserPromptSubmit を、出力の記録より先に反映するためです
    store.ingest(id);
    const a = store.get(id);
    const fields = localCommandPatch(a, sent, a ? readLocalCommandOutputAt(a.transcriptPath) : null, Date.now());
    if (fields === undefined) continue;
    // 見守りを終えたので、保存した見守りの情報も消します。残すと次の再起動で、終わったコマンドの「実行中」へ戻してしまうためです
    store.patch(id, { ...fields, localCommandWatch: null });
    return;
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
    (a.exitSentAt ? EXITING_REASON : null) ||
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
    await tmux.sendText(a.paneId, buildMemoPrompt(marker), a.id);
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
          await tmux.sendText(a.paneId, '/clear', a.id);
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
          await tmux.sendText(a.paneId, buildResumePrompt(memo, file), a.id);
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
    res.write(usageEvent());
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
      const note = await deleteAgent(a);
      return send(res, 200, note ? { ok: true, windowKept: true, note } : { ok: true });
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
    // 別のエージェントのペインだった場合だけは、空の画面ではなく理由を返します（送信と同じく 409 です）。それ以外の失敗はこれまでどおり空の画面です
    const text = await tmux.capturePane(a.paneId, a.id).catch((e) => {
      if (e.code === 'foreign-pane') throw e;
      return '';
    });
    return send(res, 200, { text });
  }
  if (req.method !== 'POST') throw httpError(405, 'Method not allowed');

  const body = await readJson(req);
  switch (action) {
    case 'send': {
      const text = String(body.text ?? '');
      if (!text.trim()) throw httpError(400, 'メッセージが空です');
      const blocked = sendBlockReason(a);
      if (blocked) throw Object.assign(httpError(409, blocked), { code: 'blocked' });
      await tmux.sendText(a.paneId, text, a.id);
      return send(res, 200, { ok: true });
    }
    case 'queue':
      queueOp(a, body);
      return send(res, 200, { ok: true, queue: store.get(a.id).queue });
    case 'keys': {
      if (!a.alive) throw httpError(409, 'エージェントは停止しています');
      await tmux.sendKey(a.paneId, String(body.key), a.id);
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
    case 'exit':
      await exitAgent(a);
      return send(res, 200, { ok: true });
    case 'effort':
      return send(res, 200, { ok: true, ...(await changeEffort(a, body)) });
    case 'focus':
      // 別のエージェントのウィンドウを指していた ID は生存確認で消しているため、ないときは操作しません
      if (!a.windowId) throw httpError(409, 'tmux のウィンドウがありません。再起動すると新しいウィンドウで起動します');
      await tmux.focusWindow(a.windowId, a.id);
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
usage.refresh();
await reconcile();
// キューから送ったスラッシュコマンドを見守っている途中でハブが止まった場合は、続きから見守ります。
// 「実行中」への戻しはイベントの読み直し（lib/store.js の init）で済んでいるため、自動送信の判定（下の changed）より先に戻っています。
// 止まっている間にコマンドの出力が記録されていれば「待機中」に戻してキューを進め、記録がないまま待ち時間を過ぎていれば一時停止します（localCommandPatch）
for (const a of store.list()) if (a.localCommandWatch) watchLocalCommand(a.id, a.localCommandWatch).catch((e) => console.error(e));
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
// コンテキスト量も、イベントの後に transcript へ書き込まれた応答を取りこぼさないよう定期的に確かめます（追記分だけを読みます）。
// TUI で実行した /effort はフックのイベントを伴わないため、同じく定期的に確かめます。
// 利用上限の記録もステータスラインから書かれ、イベントを伴わないため、ここで更新時刻を確かめます。
// 終了を送ったエージェントも、プロセスが終わったか・待ち時間を過ぎたかをここで確かめ、自動送信を止める印を外します
setInterval(() => {
  refreshUsage();
  for (const a of store.list()) {
    if (a.exitSentAt) settleExit(a.id);
    refreshContext(a.id);
    refreshEffort(a.id);
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
