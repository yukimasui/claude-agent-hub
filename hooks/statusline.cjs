#!/usr/bin/env node
'use strict';
// Agent Hub が起動するエージェントのステータスラインのコマンドです（<AGENT_HUB_HOME>/hooks.json の statusLine から呼ばれます）。
// - Claude Code が標準入力に渡す JSON から利用上限の使用率（rate_limits）を取り出し、<AGENT_HUB_HOME>/usage.json に記録します。
//   利用者の認証情報を読まずに使用率を受け取れるのは、この入力だけだからです
// - --settings の statusLine は利用者や作業ディレクトリの設定より優先されるため、それらにステータスラインの設定がある場合は、
//   同じ入力をそのコマンドに渡して出力をそのまま表示します。表示を奪わないようにするためです
// hook と同じく「エージェントの邪魔をしない」ことを最優先にし、記録に失敗しても表示の処理は続け、時間のかかる処理はしません

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// 利用者のコマンドに渡すときに付ける目印です。利用者の設定がこのスクリプト自身を指していても、呼び出しが繰り返されないようにします
const NESTED_ENV = 'AGENT_HUB_STATUSLINE_NESTED';
// 利用者のコマンドを待つ上限です。止まったままのコマンドで、このスクリプトのプロセスが残り続けないようにします
const PASS_TIMEOUT_MS = 5000;
// 同じ枠（リセットの時刻が同じ）かを判定するときの許容幅です。サーバの丸めで時刻が少しずれても同じ枠として扱います
const SAME_WINDOW_MS = 60 * 1000;
// 応答の有無を覚えておくエージェントの数の上限です。削除したエージェントの分で記録が増え続けないようにします
const MAX_SEEN = 50;
const WINDOWS = [
  ['five_hour', 'fiveHour'],
  ['seven_day', 'sevenDay'],
];

/** 入力の 1 つの枠（{ used_percentage, resets_at }。resets_at は Unix 秒）を記録の形にします。読めない値は null です */
function pickWindow(w, receivedAt, agentId) {
  if (!w || typeof w !== 'object') return null;
  const used = Number(w.used_percentage);
  const resets = Number(w.resets_at);
  if (w.used_percentage == null || w.resets_at == null || !Number.isFinite(used) || !Number.isFinite(resets)) return null;
  return { usedPercentage: used, resetsAt: resets * 1000, receivedAt, ...(agentId ? { agentId } : {}) };
}

/** 入力から 5 時間の枠と週の枠を取り出します。どちらもなければ（API キーでの利用、最初の応答の前など）null です */
function pickRateLimits(input, receivedAt, agentId) {
  const rl = input && typeof input === 'object' ? input.rate_limits : null;
  if (!rl || typeof rl !== 'object') return null;
  const out = {};
  for (const [src, key] of WINDOWS) {
    const w = pickWindow(rl[src], receivedAt, agentId);
    if (w) out[key] = w;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 記録済みの枠と新しく受け取った枠のどちらを残すかを決めます。
 * 利用上限はアカウント単位で、エージェントごとに最後に API の応答を受けた時点の値を持っています。しばらく応答のないエージェントの
 * ステータスラインが更新されると古い値が届くため、単純に上書きすると、ほかのエージェントが受け取った新しい値が古い値に戻ってしまいます。
 * そこで、リセットの時刻が後の枠（新しい枠）を優先し、同じ枠なら使用率が高いほう（同じ枠の中で使用率は減らないため、より新しい値）を残します。
 * 使用率が同じ場合は、そのエージェントが前回の実行から API の応答を受けている（fresh）ときだけ新しいほうを残して受け取った時刻を進めます。
 * 応答のないまま再描画された（リセットの時刻や権限モードの変更など）だけの値で時刻を進めると、古い値が新しく見えてしまうためです。
 */
function mergeWindow(prev, next, { fresh = true } = {}) {
  if (!next) return prev || null;
  if (!prev) return next;
  if (next.resetsAt > prev.resetsAt + SAME_WINDOW_MS) return next;
  if (next.resetsAt < prev.resetsAt - SAME_WINDOW_MS) return prev;
  if (next.usedPercentage > prev.usedPercentage) return next;
  return fresh && next.usedPercentage === prev.usedPercentage ? next : prev;
}

/** 記録（{ fiveHour, sevenDay }）に新しく受け取った値を反映した枠を返します。fresh は mergeWindow と同じです */
function mergeUsage(prev, next, { fresh = true } = {}) {
  const out = {};
  for (const [, key] of WINDOWS) {
    const w = mergeWindow(prev && typeof prev === 'object' ? validWindow(prev[key]) : null, next ? next[key] : null, { fresh });
    if (w) out[key] = w;
  }
  return out;
}

/**
 * 入力の、このプロセスが API の応答を待った時間の合計（cost.total_api_duration_ms）です。読めなければ null です。
 * 入力には使用率を得た時刻がないため、この値が前回の実行から変わったかで、その間に API の応答があった（値が新しくなった）かを判断します
 */
function apiDurationOf(input) {
  const v = input && input.cost ? input.cost.total_api_duration_ms : null;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 前回の実行から API の応答があったかを判断します。seen は記録に残したエージェントごとの前回の値です。
 * 起動し直すと値は 0 から数え直すため、増えたかではなく変わったかで判断します。前回の値がない（初めての実行）場合は、
 * rate_limits が届くのは最初の応答の後だけなので、応答があったものとして扱います。判断できない場合（エージェント ID や値がない）は、
 * 古い値を新しく見せないよう、応答がなかったものとして扱います。
 */
function isFresh(seen, agentId, apiMs) {
  if (!agentId || apiMs == null) return false;
  const last = seen && typeof seen === 'object' ? seen[agentId] : null;
  return !last || last.apiMs !== apiMs;
}

/**
 * エージェントごとの前回の値を更新します。古いものから MAX_SEEN 件を超えた分を消します。
 * 値が変わらないときは記録した時刻も変えません。応答のない再描画のたびに記録を書き直さないためです
 */
function updateSeen(seen, agentId, apiMs, now) {
  const out = { ...(seen && typeof seen === 'object' && !Array.isArray(seen) ? seen : {}) };
  if (!agentId || apiMs == null || (out[agentId] && out[agentId].apiMs === apiMs)) return out;
  out[agentId] = { apiMs, at: now };
  const ids = Object.keys(out).sort((a, b) => (Number(out[b] && out[b].at) || 0) - (Number(out[a] && out[a].at) || 0));
  for (const id of ids.slice(MAX_SEEN)) delete out[id];
  return out;
}

/** 記録ファイルから読んだ枠が使える形かを確かめます。壊れた記録で新しい値の反映を止めないよう、使えない枠はないものとして扱います */
function validWindow(w) {
  if (!w || typeof w !== 'object') return null;
  return ['usedPercentage', 'resetsAt', 'receivedAt'].every((k) => typeof w[k] === 'number' && Number.isFinite(w[k])) ? w : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/**
 * 入力の rate_limits を記録に反映します。記録には枠のほかに、応答の有無の判断に使うエージェントごとの前回の値（seen）を残します。
 * 古い値が届いて記録が変わらない場合は書き込みません。書き込んだかどうかを返します
 */
function recordUsage(file, input, { now = Date.now(), agentId } = {}) {
  const next = pickRateLimits(input, now, agentId);
  if (!next) return false;
  const prev = readJson(file);
  const prevSeen = prev && typeof prev === 'object' ? prev.seen : null;
  const apiMs = apiDurationOf(input);
  const merged = mergeUsage(prev, next, { fresh: isFresh(prevSeen, agentId, apiMs) });
  merged.seen = updateSeen(prevSeen, agentId, apiMs, now);
  if (prev && JSON.stringify(prev) === JSON.stringify(merged)) return false;
  writeJsonAtomic(file, merged);
  return true;
}

/**
 * 利用者や作業ディレクトリの設定にあるステータスラインのコマンドを返します（なければ null）。
 * Claude Code の優先順位（ローカル > プロジェクト > ユーザー）に合わせて、最初に見つかった設定を使います。
 * 管理者の設定（managed settings）は見ません。そこに statusLine があれば --settings より優先され、このスクリプト自体が呼ばれないためです。
 * 読めない・JSON として不正なファイルは、Claude Code と同じく設定がないものとして次の候補を見ます。
 */
function userStatusLine({ projectDir, env = process.env, homedir = os.homedir() } = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(homedir, '.claude');
  const files = [];
  if (projectDir) files.push(path.join(projectDir, '.claude', 'settings.local.json'), path.join(projectDir, '.claude', 'settings.json'));
  files.push(path.join(configDir, 'settings.json'));
  for (const file of files) {
    const s = readJson(file);
    const sl = s && typeof s === 'object' ? s.statusLine : null;
    if (sl && typeof sl === 'object' && sl.type === 'command' && typeof sl.command === 'string' && sl.command.trim()) return sl.command;
  }
  return null;
}

/** 利用者のコマンドに同じ入力を渡して実行し、出力をそのまま表示します。戻り値はコマンドの終了コードです */
function passThrough(command, raw, env = process.env) {
  const r = spawnSync(command, {
    shell: true,
    input: raw,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...env, [NESTED_ENV]: '1' },
    timeout: PASS_TIMEOUT_MS,
  });
  return typeof r.status === 'number' ? r.status : 0;
}

function main() {
  const chunks = [];
  // 標準入力の読み込みに失敗しても、落ちずに何も表示せず終わります（hub-hook.cjs と同じ考え方です）
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const raw = Buffer.concat(chunks);
    let input = null;
    try {
      input = JSON.parse(raw.toString('utf8') || '{}');
    } catch {}
    const home = process.env.AGENT_HUB_HOME;
    const agentId = process.env.AGENT_HUB_AGENT;
    if (home && input) {
      try {
        recordUsage(path.join(home, 'usage.json'), input, { agentId: agentId && /^[A-Za-z0-9_-]+$/.test(agentId) ? agentId : undefined });
      } catch {}
    }
    let code = 0;
    if (!process.env[NESTED_ENV]) {
      try {
        // プロジェクトの設定は、Claude Code が読む場所（起動時の作業ディレクトリ。入力の workspace.project_dir）だけを見ます。
        // 現在のディレクトリ（cwd）は作業中に移動した別の場所を指しうるため、代わりに使うと Claude Code が本来実行しないコマンドを実行してしまいます。
        // project_dir がない場合（入力が不正な場合を含む）は、利用者の設定だけを見ます
        const pd = input && input.workspace ? input.workspace.project_dir : null;
        const projectDir = typeof pd === 'string' && pd ? pd : null;
        const command = userStatusLine({ projectDir });
        if (command) code = passThrough(command, raw);
      } catch {}
    }
    process.exit(code);
  });
}

module.exports = { NESTED_ENV, mergeUsage, mergeWindow, pickRateLimits, recordUsage, userStatusLine };

if (require.main === module) main();
