// tmux 操作のラッパです。シェルを経由せず execFile で呼び出します
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { TMUX_SESSION } from './config.js';
import { FOREIGN_HINT, OWNER_OPTION, PANE_FORMAT, paneTargetBlockReason, parsePanes, windowTargetBlockReason } from './panes.js';

/**
 * コマンドを実行し、input があれば標準入力に渡します。結果は終了状態で判定し、失敗なら reject します。
 * テストで tmux を起動せずに確かめられるよう、実行するコマンドを引数で受け取ります。
 */
export function execWithInput(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} ${args[0]}: ${(stderr || err.message).trim()}`;
        reject(err);
      } else resolve(stdout);
    });
    // コマンドが標準入力を読まずに終了すると（tmux の has-session が失敗した場合など）、書き込みが EPIPE になります。
    // この error を受けないとプロセス全体が落ちてハブが止まるため、受けたうえで無視し、成否は終了状態で判定します。
    p.stdin.on('error', () => {});
    // 入力がないときは書き込みそのものをしないことで、不要な EPIPE を起こさないようにします
    if (input == null) p.stdin.end();
    else p.stdin.end(input);
  });
}

export function tmux(args, input) {
  return execWithInput('tmux', args, input);
}

export async function hasSession() {
  try {
    await tmux(['has-session', '-t', `=${TMUX_SESSION}`]);
    return true;
  } catch {
    return false;
  }
}

// ステータス行で状態ごとに色分けするフォーマットです
const STATUS_FMT =
  '#{?#{==:#{@hub_state},waiting},#[fg=colour196],' +
  '#{?#{==:#{@hub_state},running},#[fg=colour220],' +
  '#{?#{==:#{@hub_state},done},#[fg=colour46],}}}' +
  '#I:#W#{?#{@hub_state}, [#{@hub_state}],}#[default]';

/**
 * ペインにエージェント ID を付けます。ペイン ID は tmux のサーバーが変わると使い回されるため、
 * 生存確認でペインが本当にそのエージェントのものかを確かめられるようにします（lib/panes.js）
 */
async function setPaneOwner(paneId, agentId) {
  await tmux(['set-option', '-p', '-t', paneId, OWNER_OPTION, agentId]).catch(() => {});
}

/** エージェント用のウィンドウを作ります。{windowId, paneId} を返します */
export async function createWindow({ agentId, name, cwd, env, command }) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const fmt = ['-P', '-F', '#{window_id} #{pane_id}'];
  const args = (await hasSession())
    ? ['new-window', '-d', '-t', `${TMUX_SESSION}:`, '-n', name, '-c', cwd, ...envArgs, ...fmt, command]
    : ['new-session', '-d', '-s', TMUX_SESSION, '-x', '180', '-y', '50', '-n', name, '-c', cwd, ...envArgs, ...fmt, command];
  const out = (await tmux(args)).trim();
  const [windowId, paneId] = out.split(' ');
  await setPaneOwner(paneId, agentId);
  // 終了してもペインを残してエラー内容を見られるようにします
  await tmux(['set-option', '-w', '-t', windowId, 'remain-on-exit', 'on']).catch(() => {});
  await tmux(['set-option', '-w', '-t', windowId, 'window-status-format', STATUS_FMT]).catch(() => {});
  await tmux(['set-option', '-w', '-t', windowId, 'window-status-current-format', `#[reverse]${STATUS_FMT}`]).catch(() => {});
  return { windowId, paneId };
}

export async function respawnPane({ agentId, paneId, cwd, env, command }) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  await tmux(['respawn-pane', '-k', '-t', paneId, '-c', cwd, ...envArgs, command]);
  // エージェント ID を付けるしくみより前に作ったペインにはエージェント ID が付いていないため、起動し直すときにも付けます
  await setPaneOwner(paneId, agentId);
}

/**
 * エージェントのウィンドウを閉じます。agentId はウィンドウの持ち主のエージェントで、閉じる直前に確かめるために使います。
 * 別のエージェントのウィンドウか、ハブのものではないウィンドウなら閉じずに 409 のエラーを投げます（閉じると取り返しがつかないためです）
 */
export async function killWindow(windowId, agentId) {
  await assertWindowTarget(windowId, agentId, 'ウィンドウを閉じませんでした');
  await tmux(['kill-window', '-t', windowId]);
}

/**
 * プロセスの環境変数を読みます。/proc がない環境や、読めないプロセスでは null を返します。
 * 内容が空の場合（終了処理中のプロセスなど）も null を返します。空のまま返すと AGENT_HUB_AGENT がないことになり、
 * 持ち主の判定（lib/panes.js の parsePanes）でハブのものではないペインとみなされ、正しい持ち主のペイン ID を消してしまうためです。
 * procDir は、テストで /proc の代わりに一時ディレクトリを読ませるための引数です。
 */
export function readEnviron(pid, procDir = '/proc') {
  try {
    const buf = fs.readFileSync(`${procDir}/${pid}/environ`);
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

/** ペインの生存状況と持ち主を Map<paneId, {dead, windowId, owner}> で返します（owner の意味は lib/panes.js の parsePanes を参照） */
export async function listPanes() {
  try {
    return parsePanes(await tmux(['list-panes', '-s', '-t', `=${TMUX_SESSION}`, '-F', PANE_FORMAT]), readEnviron);
  } catch {
    // セッションが無ければ空です
    return new Map();
  }
}

/**
 * ステータス行に状態を書き込みます。agentId はウィンドウの持ち主のエージェントです。
 * 書き込みが別のエージェントのウィンドウに残ると、そのエージェントの状態が次に変わるまで誤った表示が続くため、書き込む前に持ち主を確かめます
 */
export async function setWindowState(windowId, state, agentId) {
  const [err] = await setWindowStates([{ windowId, state, agentId }]);
  if (err) throw err;
}

/**
 * 複数のウィンドウのステータス行に状態を書き込みます。updates は { windowId, state, agentId } の並びで、
 * 項目ごとの結果（書き込めたら null、書き込まなかったらそのエラー）の並びを返します。
 * 持ち主の確かめ方は setWindowState と同じで、書き込む直前に取ったペインの一覧で判定します。
 * 項目ごとにウィンドウ内のペインの一覧（list-panes）を取ると、状態の変化の数だけ tmux を余分に起動するため、次のようにまとめます。
 * - panes（listPanes の値）を渡したときは、それを使います。生存確認（server.js の reconcile）で取った直後の一覧を再利用するためのものです
 * - 渡さず、項目が 2 つ以上あるときは、セッション内のペインの一覧を 1 回だけ取って使います
 * - 項目が 1 つのときは、これまでどおりそのウィンドウの一覧だけを取ります（セッション全体より読むペインが少ないためです）
 * 一覧にないウィンドウは、ハブのセッションの外のウィンドウか閉じられたウィンドウなので、そのウィンドウの一覧を取って確かめます。
 * セッション内の一覧だけで判定すると、tmux のサーバーが変わってウィンドウ ID が利用者の別のセッションのウィンドウに割り当てられた場合に、
 * 持ち主が分からないものとして書き込んでしまうためです
 */
export async function setWindowStates(updates, panes) {
  if (!updates.length) return [];
  const snapshot = panes ?? (updates.length > 1 ? await listPanes() : new Map());
  const byWindow = new Map();
  for (const p of snapshot.values()) {
    if (!byWindow.has(p.windowId)) byWindow.set(p.windowId, []);
    byWindow.get(p.windowId).push(p);
  }
  const results = [];
  for (const { windowId, state, agentId } of updates) {
    try {
      const inWindow = byWindow.get(windowId) ?? (await describeWindow(windowId));
      const reason = windowTargetBlockReason(agentId, inWindow, 'ステータス行を更新しませんでした');
      if (reason) throw foreignError(reason);
      await tmux(['set-option', '-w', '-t', windowId, '@hub_state', state]);
      results.push(null);
    } catch (e) {
      results.push(e);
    }
  }
  return results;
}

/**
 * 同じ内容の記録を、interval ミリ秒に 1 回までに抑えて log に渡す関数を返します。返す関数は (key, message, now) を受け取り、記録したら true を返します。
 * 持ち主の確認は送信・画面の取得・ステータス行の更新のたびに行い、画面の取得は表示中に繰り返し呼ばれるため、
 * 同じ失敗が続くと記録が大量に出てほかのログを埋めてしまうためです。覚えておく内容は max 件までにし、古いものから忘れます。
 */
export function throttledLog(log, { interval = 60_000, max = 200 } = {}) {
  const last = new Map();
  return (key, message, now = Date.now()) => {
    const at = last.get(key);
    if (at != null && now - at < interval) return false;
    // 記録した順に並べ直し、上限を超えたら最も前に記録したものから消します
    last.delete(key);
    last.set(key, now);
    while (last.size > max) last.delete(last.keys().next().value);
    log(message);
    return true;
  };
}

// 呼び出しのたびに console.warn を引くのは、テストで差し替えた記録先にも渡すためです
const warnCheckFailure = throttledLog((m) => console.warn(m));

/**
 * 操作の直前の持ち主の確認に失敗したことを、対象と理由とともに記録します。
 * 確認に失敗しても操作は止めない（paneTargetBlockReason・windowTargetBlockReason）ため、記録がないと、
 * 持ち主を確かめないまま操作したことや、その原因（ペインがない、tmux を実行できないなど）を後から調べられないためです
 */
function logCheckFailure(kind, target, reason) {
  warnCheckFailure(`${kind}\t${target}\t${reason}`, `${kind} ${target} の持ち主を確かめられませんでした（操作は止めずに続けます）: ${reason}`);
}

/**
 * 状態が変わったウィンドウのステータス行を、少し待ってからまとめて書き込む仕組みを返します。
 * 書き込みの前には持ち主を確かめるため（setWindowStates）、状態が変わるたびに書き込むと、そのたびにペインの一覧を取ることになるためです。
 * - mark(id): エージェント id の状態が変わったことを伝えます。delay ミリ秒後に、それまでに伝えられた分をまとめて書き込みます
 * - flush(panes): 待たずに書き込みます。panes は生存確認で取った直後のペインの一覧で、それを使って一覧の取り直しを省きます
 * current(id) は、書き込む時点のエージェントの { windowId, state, agentId } を返す関数です（エージェントがないかウィンドウがなければ null）。
 * 書き込む時点の値を使うので、待つ間に続けて変わった状態は最後の状態だけを書きます。
 * 書き込んだ（書き込もうとした）状態を覚え、同じ状態は書き直しません。別のエージェントのウィンドウだったなどで書き込めなかった場合も、
 * 状態が変わるまで繰り返し試さないよう、書き込む前に覚えます。write はテストで書き込みの代わりを渡すための引数です
 */
export function windowStateWriter(current, { delay = 100, write = setWindowStates } = {}) {
  const written = new Map(); // エージェント ID -> 書き込んだ状態
  const dirty = new Set();
  let timer = null;
  let flushing = false;
  const schedule = () => {
    if (timer || flushing) return;
    timer = setTimeout(() => flush().catch((e) => console.error(e)), delay);
  };
  const mark = (id) => {
    const u = current(id);
    if (!u) {
      // 削除されたかウィンドウがなくなったエージェントは忘れます。後から新しいウィンドウで起動し直したときに、前と同じ状態でも書き込むためです
      written.delete(id);
      return;
    }
    if (written.get(id) === u.state) return;
    dirty.add(id);
    schedule();
  };
  async function flush(panes) {
    clearTimeout(timer);
    timer = null;
    // 書き込みの途中で次を始めると、古い状態の書き込みが新しい状態の後に届くおそれがあるため、終わってから改めて書き込みます
    if (flushing) return;
    const updates = [];
    for (const id of dirty) {
      const u = current(id);
      if (!u || written.get(id) === u.state) continue;
      written.set(id, u.state);
      updates.push(u);
    }
    dirty.clear();
    if (!updates.length) return;
    flushing = true;
    try {
      await write(updates, panes);
    } finally {
      flushing = false;
      if (dirty.size) schedule();
    }
  }
  return { mark, flush };
}

/** 1 つのペインの生存状況と持ち主を、listPanes の値と同じ形で返します。ペインがないなど、確かめられなければ理由を記録して undefined を返します */
async function describePane(paneId) {
  let out;
  try {
    out = await tmux(['display-message', '-p', '-t', paneId, PANE_FORMAT]);
  } catch (e) {
    logCheckFailure('ペイン', paneId, e.message);
    return undefined;
  }
  const pane = parsePanes(out, readEnviron).get(paneId);
  // tmux が別のペインの情報を返した場合などです。違うペインの持ち主で判定しないよう、確かめられなかったものとします
  if (!pane) logCheckFailure('ペイン', paneId, 'tmux の応答にペインの情報がありませんでした');
  return pane;
}

/** ウィンドウ内のペインの生存状況と持ち主を、listPanes の値と同じ形の並びで返します。ウィンドウがないなど、確かめられなければ理由を記録して undefined を返します */
async function describeWindow(windowId) {
  let out;
  try {
    out = await tmux(['list-panes', '-t', windowId, '-F', PANE_FORMAT]);
  } catch (e) {
    logCheckFailure('ウィンドウ', windowId, e.message);
    return undefined;
  }
  return [...parsePanes(out, readEnviron).values()];
}

const foreignError = (reason) => Object.assign(new Error(reason), { status: 409, code: 'foreign-pane' });

/**
 * 操作の直前に、ペインがそのエージェント（agentId）のものかを確かめ、別のエージェントのものなら 409 のエラーを投げます。
 * 判定は lib/panes.js の paneTargetBlockReason が行います。確かめられなかった場合は操作を止めず、操作の側の成否に任せます
 */
async function assertPaneTarget(paneId, agentId, outcome) {
  const reason = paneTargetBlockReason(agentId, await describePane(paneId), `${outcome}。${FOREIGN_HINT}`);
  if (reason) throw foreignError(reason);
}

/** assertPaneTarget のウィンドウ版です。判定は lib/panes.js の windowTargetBlockReason が行います。outcome は理由の文にそのまま入ります */
async function assertWindowTarget(windowId, agentId, outcome) {
  const reason = windowTargetBlockReason(agentId, await describeWindow(windowId), outcome);
  if (reason) throw foreignError(reason);
}

/** 複数行もそのまま渡せるよう bracketed paste で送ってから Enter します。agentId は送り先のエージェントで、ペインの持ち主を確かめるために使います */
export async function sendText(paneId, text, agentId) {
  await assertPaneTarget(paneId, agentId, '送信しませんでした');
  const buf = `hub-${process.pid}-${Date.now()}`;
  await tmux(['load-buffer', '-b', buf, '-'], text);
  await tmux(['paste-buffer', '-d', '-p', '-b', buf, '-t', paneId]);
  await new Promise((r) => setTimeout(r, 120));
  await tmux(['send-keys', '-t', paneId, 'Enter']);
}

export const ALLOWED_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Tab', 'BTab', 'C-c', '1', '2', '3']);

/** 許可したキーを送ります。agentId は sendText と同じく、ペインの持ち主を確かめるために使います */
export async function sendKey(paneId, key, agentId) {
  if (!ALLOWED_KEYS.has(key)) throw Object.assign(new Error(`許可されていないキーです: ${key}`), { status: 400 });
  await assertPaneTarget(paneId, agentId, '送信しませんでした');
  await tmux(['send-keys', '-t', paneId, key]);
}

/** ペインの画面を取得します。agentId は sendText と同じく、別のエージェントの画面を返さないよう持ち主を確かめるために使います */
export async function capturePane(paneId, agentId) {
  await assertPaneTarget(paneId, agentId, '画面を取得しませんでした');
  return tmux(['capture-pane', '-p', '-t', paneId]);
}

/**
 * tmux 側でそのウィンドウを前面に出します（アタッチ中のクライアントがあれば切り替えます）。
 * agentId は killWindow と同じく、別のエージェントのウィンドウを前面に出さないよう持ち主を確かめるために使います
 */
export async function focusWindow(windowId, agentId) {
  await assertWindowTarget(windowId, agentId, `tmux で表示しませんでした。${FOREIGN_HINT}`);
  await tmux(['select-window', '-t', windowId]);
  await tmux(['switch-client', '-t', windowId]).catch(() => {});
}
