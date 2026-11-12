// tmux 操作のラッパです。シェルを経由せず execFile で呼び出します
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { TMUX_SESSION } from './config.js';
import { OWNER_OPTION, PANE_FORMAT, parsePanes, sendTargetBlockReason } from './panes.js';

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

export async function killWindow(windowId) {
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

export async function setWindowState(windowId, state) {
  await tmux(['set-option', '-w', '-t', windowId, '@hub_state', state]);
}

/** 1 つのペインの生存状況と持ち主を、listPanes の値と同じ形で返します。ペインがないなど、確かめられなければ undefined です */
async function describePane(paneId) {
  try {
    return parsePanes(await tmux(['display-message', '-p', '-t', paneId, PANE_FORMAT]), readEnviron).get(paneId);
  } catch {
    return undefined;
  }
}

/**
 * 送る直前に、ペインが送り先のエージェント（agentId）のものかを確かめ、別のエージェントのものなら 409 のエラーを投げます。
 * 判定は lib/panes.js の sendTargetBlockReason が行います。確かめられなかった場合は送信を止めず、送信の側の成否に任せます
 */
async function assertSendTarget(paneId, agentId) {
  const reason = sendTargetBlockReason(agentId, await describePane(paneId));
  if (reason) throw Object.assign(new Error(reason), { status: 409, code: 'foreign-pane' });
}

/** 複数行もそのまま渡せるよう bracketed paste で送ってから Enter します。agentId は送り先のエージェントで、ペインの持ち主を確かめるために使います */
export async function sendText(paneId, text, agentId) {
  await assertSendTarget(paneId, agentId);
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
  await assertSendTarget(paneId, agentId);
  await tmux(['send-keys', '-t', paneId, key]);
}

export async function capturePane(paneId) {
  return tmux(['capture-pane', '-p', '-t', paneId]);
}

/** tmux 側でそのウィンドウを前面に出します（アタッチ中のクライアントがあれば切り替えます） */
export async function focusWindow(windowId) {
  await tmux(['select-window', '-t', windowId]);
  await tmux(['switch-client', '-t', windowId]).catch(() => {});
}
