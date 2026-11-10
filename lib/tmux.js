// tmux 操作のラッパにゃ。シェルを経由せず execFile で叩くにゃ
import { execFile } from 'node:child_process';
import { TMUX_SESSION } from './config.js';

export function tmux(args, input) {
  return new Promise((resolve, reject) => {
    const p = execFile('tmux', args, { maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `tmux ${args[0]}: ${(stderr || err.message).trim()}`;
        reject(err);
      } else resolve(stdout);
    });
    p.stdin.end(input ?? '');
  });
}

export async function hasSession() {
  try {
    await tmux(['has-session', '-t', `=${TMUX_SESSION}`]);
    return true;
  } catch {
    return false;
  }
}

// ステータス行で状態ごとに色分けするフォーマットにゃ
const STATUS_FMT =
  '#{?#{==:#{@hub_state},waiting},#[fg=colour196],' +
  '#{?#{==:#{@hub_state},running},#[fg=colour220],' +
  '#{?#{==:#{@hub_state},done},#[fg=colour46],}}}' +
  '#I:#W#{?#{@hub_state}, [#{@hub_state}],}#[default]';

/** エージェント用のウィンドウを作るにゃ。{windowId, paneId} を返すにゃ */
export async function createWindow({ name, cwd, env, command }) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const fmt = ['-P', '-F', '#{window_id} #{pane_id}'];
  const args = (await hasSession())
    ? ['new-window', '-d', '-t', `${TMUX_SESSION}:`, '-n', name, '-c', cwd, ...envArgs, ...fmt, command]
    : ['new-session', '-d', '-s', TMUX_SESSION, '-x', '180', '-y', '50', '-n', name, '-c', cwd, ...envArgs, ...fmt, command];
  const out = (await tmux(args)).trim();
  const [windowId, paneId] = out.split(' ');
  // 終了してもペインを残してエラー内容を見られるようにするにゃ
  await tmux(['set-option', '-w', '-t', windowId, 'remain-on-exit', 'on']).catch(() => {});
  await tmux(['set-option', '-w', '-t', windowId, 'window-status-format', STATUS_FMT]).catch(() => {});
  await tmux(['set-option', '-w', '-t', windowId, 'window-status-current-format', `#[reverse]${STATUS_FMT}`]).catch(() => {});
  return { windowId, paneId };
}

export async function respawnPane({ paneId, cwd, env, command }) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  await tmux(['respawn-pane', '-k', '-t', paneId, '-c', cwd, ...envArgs, command]);
}

export async function killWindow(windowId) {
  await tmux(['kill-window', '-t', windowId]);
}

/** ペインの生存状況を Map<paneId, {dead, windowId}> で返すにゃ */
export async function listPanes() {
  const map = new Map();
  try {
    const out = await tmux(['list-panes', '-s', '-t', `=${TMUX_SESSION}`, '-F', '#{pane_id} #{pane_dead} #{window_id}']);
    for (const line of out.split('\n')) {
      const [paneId, dead, windowId] = line.trim().split(' ');
      if (paneId) map.set(paneId, { dead: dead === '1', windowId });
    }
  } catch {
    // セッションが無ければ空にゃ
  }
  return map;
}

export async function setWindowState(windowId, state) {
  await tmux(['set-option', '-w', '-t', windowId, '@hub_state', state]);
}

/** 複数行もそのまま渡せるよう bracketed paste で送ってから Enter するにゃ */
export async function sendText(paneId, text) {
  const buf = `hub-${process.pid}-${Date.now()}`;
  await tmux(['load-buffer', '-b', buf, '-'], text);
  await tmux(['paste-buffer', '-d', '-p', '-b', buf, '-t', paneId]);
  await new Promise((r) => setTimeout(r, 120));
  await tmux(['send-keys', '-t', paneId, 'Enter']);
}

export const ALLOWED_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Tab', 'BTab', 'C-c', '1', '2', '3']);

export async function sendKey(paneId, key) {
  if (!ALLOWED_KEYS.has(key)) throw Object.assign(new Error(`許可されていないキーです: ${key}`), { status: 400 });
  await tmux(['send-keys', '-t', paneId, key]);
}

export async function capturePane(paneId) {
  return tmux(['capture-pane', '-p', '-t', paneId]);
}

/** tmux 側でそのウィンドウを前面に出すにゃ（アタッチ中のクライアントがあれば切り替えるにゃ） */
export async function focusWindow(windowId) {
  await tmux(['select-window', '-t', windowId]);
  await tmux(['switch-client', '-t', windowId]).catch(() => {});
}
