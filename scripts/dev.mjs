#!/usr/bin/env node
// 開発用ハブのランチャーです。
// 本番のハブ（ポート 4317 / ~/.agent-hub / tmux セッション agent-hub）と分離した設定で
// `node --watch server.js` を起動し、ファイルの変更で自動的に再起動させます。
// シェルごとの環境変数の書き方の違いを避けるため、npm スクリプトから直接 env を書かずに Node で設定しています。
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// lib/config.js の既定値（＝本番の設定）です。開発用ハブがこれらと重ならないよう確かめます
const PROD = { port: 4317, home: path.join(os.homedir(), '.agent-hub'), session: 'agent-hub' };

const DEV_DEFAULTS = {
  HUB_PORT: '4400',
  AGENT_HUB_HOME: path.join(os.homedir(), '.agent-hub-dev'),
  HUB_TMUX_SESSION: 'agent-hub-dev',
};

const env = { ...process.env };

// ハブが起動したエージェントの中（tmux ペイン）では、親のハブの AGENT_HUB_AGENT / AGENT_HUB_HOME が
// 引き継がれています。そのまま使うと開発用ハブが本番のデータ置き場を読み書きしてしまうため、
// この場合は AGENT_HUB_HOME を利用者の指定とはみなさず、開発用の既定値に置き換えます。
if (env.AGENT_HUB_AGENT) {
  if (env.AGENT_HUB_HOME) console.log(`[dev] ハブ管理下のエージェント内で実行されているため、引き継がれた AGENT_HUB_HOME（${env.AGENT_HUB_HOME}）は使用しません。`);
  delete env.AGENT_HUB_AGENT;
  delete env.AGENT_HUB_HOME;
}

for (const [k, v] of Object.entries(DEV_DEFAULTS)) {
  if (!env[k]) env[k] = v;
}

const problems = [];
if (Number(env.HUB_PORT) === PROD.port) problems.push(`HUB_PORT が本番と同じ ${PROD.port} です`);
if (path.resolve(env.AGENT_HUB_HOME) === PROD.home) problems.push(`AGENT_HUB_HOME が本番と同じ ${PROD.home} です`);
if (env.HUB_TMUX_SESSION === PROD.session) problems.push(`HUB_TMUX_SESSION が本番と同じ ${PROD.session} です`);
if (problems.length) {
  console.error(`[dev] 本番のハブと設定が重なるため起動しません:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

console.log(`[dev] 開発用ハブを起動します（ファイルの変更で自動的に再起動します）`);
console.log(`[dev]   HUB_PORT=${env.HUB_PORT} AGENT_HUB_HOME=${env.AGENT_HUB_HOME} HUB_TMUX_SESSION=${env.HUB_TMUX_SESSION}`);

const child = spawn(process.execPath, ['--watch', 'server.js'], { cwd: ROOT, env, stdio: 'inherit' });

// 端末からの Ctrl+C は子プロセスにも届きますが、kill などで親だけが受け取った場合にも確実に止めます
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
