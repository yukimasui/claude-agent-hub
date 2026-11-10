#!/usr/bin/env node
// 開発用ハブのランチャーです。
// 本番のハブ（ポート 4317 / ~/.agent-hub / tmux セッション agent-hub）と分離した設定で
// `node --watch server.js` を起動し、ファイルの変更で自動的に再起動させます。
// シェルごとの環境変数の書き方の違いを避けるため、npm スクリプトから直接 env を書かずに Node で設定しています。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** lib/config.js の既定値（＝本番の設定）です。開発用ハブがこれらと重ならないよう確かめます */
export function prodSettings(homedir = os.homedir()) {
  return { port: 4317, home: path.join(homedir, '.agent-hub'), session: 'agent-hub' };
}

/** 開発用ハブの既定値です。環境変数で指定がない項目に使います */
export function devDefaults(homedir = os.homedir()) {
  return {
    HUB_PORT: '4400',
    AGENT_HUB_HOME: path.join(homedir, '.agent-hub-dev'),
    HUB_TMUX_SESSION: 'agent-hub-dev',
  };
}

/**
 * データ置き場 home が、エージェント agentId を起動したハブのものかを返します。
 * ハブはエージェントを作成すると agents.json に登録し、hook はそのエージェントのイベントを events/<ID>.jsonl に
 * 書きます。エージェント ID はハブごとに無作為に振られるため、これらの記録があれば起動元のハブと判断できます。
 * 環境変数だけでは「親のハブから引き継いだ値」と「利用者が指定した値」を区別できないため、記録を見て判断します。
 * 読み取るだけで、データ置き場には何も書きません。
 */
export function isLaunchedFrom(home, agentId) {
  if (!home || !agentId) return false;
  if (fs.existsSync(path.join(home, 'events', `${agentId}.jsonl`))) return true;
  try {
    const list = JSON.parse(fs.readFileSync(path.join(home, 'agents.json'), 'utf8'));
    return Array.isArray(list) && list.some((a) => a && a.id === agentId);
  } catch {
    return false;
  }
}

/**
 * 開発用ハブに渡す環境変数を決めます。
 * 起動を止めるべき理由は problems に、起動時に知らせる内容は notes に入れて返し、表示と終了は呼び出し側で行います。
 * 単体テストで利用者のホームに触れないよう、ホームディレクトリは引数で差し替えられます。
 */
export function resolveDevEnv(baseEnv, { homedir = os.homedir() } = {}) {
  const env = { ...baseEnv };
  const notes = [];
  const problems = [];
  const PROD = prodSettings(homedir);

  // ハブが起動したエージェントの中（tmux ペイン）では、親のハブの AGENT_HUB_AGENT / AGENT_HUB_HOME が
  // 引き継がれています。引き継いだ AGENT_HUB_HOME をそのまま使うと、開発用ハブが親のハブ（本番とは限りません）の
  // データ置き場を読み書きしてしまうため、親のデータ置き場だと判断できた場合だけ開発用の既定値に置き換えます。
  // 別の値が指定されていれば、利用者が意図して指定したものとしてそのまま使います。
  // AGENT_HUB_AGENT は開発用ハブ自身には不要なので、開発用ハブのプロセスや開発用ハブが作る tmux セッションに
  // 親のエージェント ID が残らないよう、これまでどおり消します。
  const agentId = env.AGENT_HUB_AGENT;
  delete env.AGENT_HUB_AGENT;
  if (agentId && env.AGENT_HUB_HOME) {
    if (isLaunchedFrom(path.resolve(env.AGENT_HUB_HOME), agentId)) {
      notes.push(`AGENT_HUB_HOME（${env.AGENT_HUB_HOME}）はこのエージェントを起動したハブのデータ置き場のため使用しません。開発用の既定値を使います。`);
      delete env.AGENT_HUB_HOME;
    } else {
      notes.push(`AGENT_HUB_HOME（${env.AGENT_HUB_HOME}）はこのエージェントを起動したハブのデータ置き場ではないため、指定どおり使用します。`);
    }
  }

  for (const [k, v] of Object.entries(devDefaults(homedir))) {
    if (!env[k]) env[k] = v;
  }

  // 親が開発用ハブの場合は、置き換え先の既定値が親のデータ置き場と同じになることがあります。
  // 共有すると互いのエージェントの状態が混ざるため、別の値を指定するよう求めて起動しません。
  const home = path.resolve(env.AGENT_HUB_HOME);
  if (agentId && isLaunchedFrom(home, agentId)) {
    problems.push(`AGENT_HUB_HOME（${home}）は、このエージェントを起動したハブのデータ置き場です。HUB_PORT・AGENT_HUB_HOME・HUB_TMUX_SESSION に別の値を指定してください`);
  }
  if (Number(env.HUB_PORT) === PROD.port) problems.push(`HUB_PORT が本番と同じ ${PROD.port} です`);
  if (home === PROD.home) problems.push(`AGENT_HUB_HOME が本番と同じ ${PROD.home} です`);
  if (env.HUB_TMUX_SESSION === PROD.session) problems.push(`HUB_TMUX_SESSION が本番と同じ ${PROD.session} です`);
  return { env, notes, problems };
}

function main() {
  const { env, notes, problems } = resolveDevEnv(process.env);
  for (const n of notes) console.log(`[dev] ${n}`);
  if (problems.length) {
    console.error(`[dev] ほかのハブと設定が重なるため起動しません:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
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
}

// テストから判定処理だけを読み込めるよう、直接実行されたときだけ起動します
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
