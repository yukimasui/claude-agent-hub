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
const { spawn } = require('child_process');

// 利用者のコマンドに渡すときに付ける目印です。利用者の設定がこのスクリプト自身を指していても、呼び出しが繰り返されないようにします
const NESTED_ENV = 'AGENT_HUB_STATUSLINE_NESTED';
// 利用者のコマンドを待つ上限です。止まったままのコマンドで、このスクリプトのプロセスが残り続けないようにします
const PASS_TIMEOUT_MS = 5000;
// 打ち切りで SIGTERM を送ってから、終わらないプロセスに SIGKILL を送るまでの猶予です。後始末の時間を少しだけ与えつつ、表示を長く止めないためです
const KILL_GRACE_MS = 500;
// usage.json の更新の排他に使うロックを待つ上限です。ステータスラインの表示を遅らせないよう、取れなければ今回の記録はあきらめます。
// 値は次の更新（応答のたびに届きます）で記録されるため、1 回分を記録しなくても表示が一時的に古くなるだけです
const LOCK_WAIT_MS = 150;
// これより古いロックは、持ち主が終了した（Claude Code に打ち切られたなど）ものとして取り除きます。
// ロックを持つ間は小さなファイルを読み書きするだけで、通常は数ミリ秒で終わるため、十分に長い値にしています
const LOCK_STALE_MS = 2000;
// 同じ枠（リセットの時刻が同じ）かを判定するときの許容幅です。サーバの丸めで時刻が少しずれても同じ枠として扱います
const SAME_WINDOW_MS = 60 * 1000;
// 応答の有無を覚えておくエージェントの数の上限です。削除したエージェントの分で記録が増え続けないようにします
const MAX_SEEN = 50;
// 入力の rate_limits の枠と、記録での名前です。spend_limit は Claude apps ゲートウェイが設定した利用額の上限です
const WINDOWS = [
  ['five_hour', 'fiveHour'],
  ['seven_day', 'sevenDay'],
  ['spend_limit', 'spendLimit'],
];
// spend_limit の period として受け付ける値です（Claude Code の文書に記載の値）。未知の値は記録しません
const SPEND_PERIODS = ['daily', 'weekly', 'monthly'];
// 利用額の項目です。使用率とは別の間隔で届き、欠けることがあるため、まとめて扱います
const SPEND_FIELDS = ['usedUsd', 'limitUsd', 'period'];

const isAmount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * spend_limit の利用額（used_usd・limit_usd）と期間（period）を記録の形にします。
 * 文書では、これらは使用率より後に別の要求で届き、欠けることがあるとされています。利用額は 2 つがそろって読めるときだけ、
 * 期間は既知の値のときだけ記録し、未知の形の値で誤った表示をしないようにします
 */
function pickSpend(w) {
  const out = {};
  if (isAmount(w.used_usd) && isAmount(w.limit_usd)) Object.assign(out, { usedUsd: w.used_usd, limitUsd: w.limit_usd });
  if (SPEND_PERIODS.includes(w.period)) out.period = w.period;
  return out;
}

/**
 * 入力の 1 つの枠（{ used_percentage, resets_at }。resets_at は Unix 秒）を記録の形にします。読めない値は null です。
 * withSpend のときは、spend_limit の利用額と期間も取り出します
 */
function pickWindow(w, receivedAt, agentId, { withSpend = false } = {}) {
  if (!w || typeof w !== 'object') return null;
  const used = Number(w.used_percentage);
  const resets = Number(w.resets_at);
  if (w.used_percentage == null || w.resets_at == null || !Number.isFinite(used) || !Number.isFinite(resets)) return null;
  return { usedPercentage: used, resetsAt: resets * 1000, receivedAt, ...(agentId ? { agentId } : {}), ...(withSpend ? pickSpend(w) : {}) };
}

/** 入力から 5 時間の枠・週の枠・利用額の上限を取り出します。どれもなければ（API キーでの利用、最初の応答の前など）null です */
function pickRateLimits(input, receivedAt, agentId) {
  const rl = input && typeof input === 'object' ? input.rate_limits : null;
  if (!rl || typeof rl !== 'object') return null;
  const out = {};
  for (const [src, key] of WINDOWS) {
    const w = pickWindow(rl[src], receivedAt, agentId, { withSpend: key === 'spendLimit' });
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
  if (next.usedPercentage > prev.usedPercentage) return withSpendOf(next, prev);
  return fresh && next.usedPercentage === prev.usedPercentage ? withSpendOf(next, prev) : withSpendOf(prev, next);
}

/**
 * 同じ枠の 2 つの値のうち、残すほう（kept）に利用額がなく、もう一方（other）にあれば、その利用額と期間を引き継ぎます。
 * 利用額は使用率より遅れて届くため、使用率だけの新しい値で、先に届いていた利用額を消さないようにします。
 * 引き継ぐものがなければ kept をそのまま返します
 */
function withSpendOf(kept, other) {
  if (kept.usedUsd != null || other.usedUsd == null) return kept;
  const out = { ...kept };
  for (const k of SPEND_FIELDS) if (other[k] != null) out[k] = other[k];
  return out;
}

/** 記録（{ fiveHour, sevenDay, spendLimit }）に新しく受け取った値を反映した枠を返します。fresh は mergeWindow と同じです */
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

/**
 * 一時ファイルに書いてから名前を付け替えます。読む側（サーバやほかのエージェント）に書きかけの内容が見えないようにするためです。
 * 一時ファイルの名前にはプロセス ID を含め、同時に書くほかのプロセスの一時ファイルと重ならないようにします
 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

// ロックを待つ間の短い待機です。このスクリプトは同期的に処理するため、イベントループを使わずに眠ります
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * ロックファイル（排他的な作成で取ります）を取ってから fn を実行し、その戻り値を返します。
 * 複数のエージェントが同時に「読み込み・まとめ・書き込み」をすると、後の書き込みが先の更新を上書きして失われるためです。
 * ステータスラインの表示を遅らせないよう、waitMs までに取れなければ fn を実行せずに undefined を返します。
 * staleMs より古いロックは、持ち主が途中で終了したものとして取り除きます（取り除く直前に別のプロセスが取り直した場合は
 * 2 つが同時に書くことがありえますが、その影響は排他がない場合と同じく 1 回分の更新が失われるだけで、次の更新で戻ります）。
 * 解放するときは、中身の目印が自分のものである場合だけ消し、取り除かれた後に別のプロセスが取ったロックを消さないようにします。
 */
function withLock(lockFile, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + waitMs;
  // すぐに取り直す場合（解放された・古いロックを取り除いた）も含め、毎回待ち時間の上限を確かめます。
  // 取り除けないロック（同じ名前のディレクトリなど）があっても、待ち続けないようにするためです
  for (let first = true; ; first = false) {
    if (!first && Date.now() >= deadline) return undefined;
    try {
      fs.writeFileSync(lockFile, token, { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let stale;
    try {
      // 時計が戻ると更新時刻が未来になり、差が負のまま古いと判定できなくなるため、差の大きさで判定します
      stale = Math.abs(Date.now() - fs.statSync(lockFile).mtimeMs) > staleMs;
    } catch {
      // 確かめる間に持ち主が解放した場合です。すぐに取り直します
      continue;
    }
    if (stale) {
      try {
        fs.unlinkSync(lockFile);
      } catch {}
      continue;
    }
    sleepSync(5 + Math.floor(Math.random() * 10));
  }
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lockFile, 'utf8') === token) fs.unlinkSync(lockFile);
    } catch {}
  }
}

/**
 * 入力の rate_limits を記録に反映します。記録には枠のほかに、応答の有無の判断に使うエージェントごとの前回の値（seen）を残します。
 * 古い値が届いて記録が変わらない場合と、ロックを取れなかった場合は書き込みません。書き込んだかどうかを返します。
 * lock は withLock の待ち時間などの指定です（テストで変えるために受け付けます）
 */
function recordUsage(file, input, { now = Date.now(), agentId, lock } = {}) {
  const next = pickRateLimits(input, now, agentId);
  if (!next) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(`${file}.lock`, () => mergeInto(file, next, input, { now, agentId }), lock) === true;
}

/** ロックを取った状態で、記録を読み直して新しい値を反映します。記録が変わらなければ書き込まずに false を返します */
function mergeInto(file, next, input, { now, agentId }) {
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

// プロセスグループごとに終了させられるか（POSIX のシステムか）です。Windows にはプロセスグループのシグナルがないため、起動したプロセスだけを終了させます
const USE_PROCESS_GROUP = process.platform !== 'win32';

/** プロセスがまだ残っているかを確かめます。グループの場合は pid に負の値を渡します */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM は存在するが送れない場合です。自分が起動したグループでは通常起こりませんが、残っているものとして扱います
    return e.code === 'EPERM';
  }
}

/** 起動したプロセス（POSIX ではそのプロセスグループ全体）にシグナルを送ります。すでに終わっている場合などの失敗は無視します */
function signalTree(child, signal) {
  try {
    if (USE_PROCESS_GROUP) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}

/**
 * 利用者のコマンドに同じ入力を渡して実行し、出力をそのまま表示します。終了コードで解決する Promise を返します。
 * - POSIX では新しいプロセスグループ（detached。setsid により新しいセッションになります）で起動します。打ち切るときにシェルだけでなく、
 *   シェルが起動したコマンド（孫プロセス）もまとめて終了させ、Claude Code の出力のパイプを持ったまま残らないようにするためです。
 *   終了させるのは自分が起動したグループだけで、このスクリプトや Claude Code が属するグループには送りません。
 *   新しいセッションでは制御端末（/dev/tty）を使えませんが、ステータスラインの出力はもともとパイプに書かれるため表示には影響しません
 *   （Claude Code の文書でも、端末の大きさは tput ではなく環境変数 COLUMNS・LINES から読むよう案内されています）
 * - timeoutMs を過ぎたら SIGTERM を送り、KILL_GRACE_MS 待っても残っていれば SIGKILL を送ります。打ち切った場合の終了コードは 0 です
 * - このスクリプト自身が終了を求められた（Claude Code が更新のために実行中のスクリプトを打ち切るなど）場合も、グループを終了させてから終わります
 * stdout と graceMs（強制終了までの猶予）は、テストで変えるために受け付けます。
 */
function passThrough(command, raw, { env = process.env, timeoutMs = PASS_TIMEOUT_MS, graceMs = KILL_GRACE_MS, stdout = 'inherit' } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, {
        shell: true,
        detached: USE_PROCESS_GROUP,
        stdio: ['pipe', stdout, 'inherit'],
        env: { ...env, [NESTED_ENV]: '1' },
      });
    } catch {
      resolve(0);
      return;
    }
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    let done = false;
    let timer = null;
    const unlisten = () => {
      for (const s of signals) process.removeListener(s, onSignal);
    };
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unlisten();
      resolve(code);
    };
    // グループを終了させ、残っていれば猶予の後に強制終了します。シェルが先に終わっても孫プロセスが残りうるため、グループの有無で確かめます
    const stop = (then) => {
      signalTree(child, 'SIGTERM');
      const target = USE_PROCESS_GROUP ? -child.pid : child.pid;
      const started = Date.now();
      const check = () => {
        if (!alive(target)) return then();
        if (Date.now() - started >= graceMs) {
          signalTree(child, 'SIGKILL');
          return then();
        }
        setTimeout(check, 20);
      };
      check();
    };
    // 打ち切りの後始末（stop）の途中で届いたシグナルは、done により何もしません。処理を外さずに残しておくことで、
    // 既定の動作で途中終了せず、猶予の後の SIGKILL まで進めてからグループを残さずに終わります
    function onSignal() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop(() => process.exit(0));
    }
    for (const s of signals) {
      try {
        process.on(s, onSignal);
      } catch {}
    }
    child.on('error', () => finish(0));
    child.on('exit', (code) => finish(typeof code === 'number' ? code : 0));
    // 入力を読まずに終わるコマンドでは書き込みが EPIPE になるため、エラーは無視します
    child.stdin.on('error', () => {});
    child.stdin.end(raw);
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      // シグナルの処理は stop が終わるまで外しません（onSignal の説明を参照）
      stop(() => {
        unlisten();
        resolve(0);
      });
    }, timeoutMs);
  });
}

function main() {
  const chunks = [];
  // 標準入力の読み込みに失敗しても、落ちずに何も表示せず終わります（hub-hook.cjs と同じ考え方です）
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', async () => {
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
    // 利用者のコマンドの待機中は、ほかの処理で落ちないようにします。万一の例外でも表示の処理を壊さず終了コード 0 で終わります
    process.on('uncaughtException', () => process.exit(0));
    if (!process.env[NESTED_ENV]) {
      try {
        // プロジェクトの設定は、Claude Code が読む場所（起動時の作業ディレクトリ。入力の workspace.project_dir）だけを見ます。
        // 現在のディレクトリ（cwd）は作業中に移動した別の場所を指しうるため、代わりに使うと Claude Code が本来実行しないコマンドを実行してしまいます。
        // project_dir がない場合（入力が不正な場合を含む）は、利用者の設定だけを見ます
        const pd = input && input.workspace ? input.workspace.project_dir : null;
        const projectDir = typeof pd === 'string' && pd ? pd : null;
        const command = userStatusLine({ projectDir });
        if (command) code = await passThrough(command, raw);
      } catch {}
    }
    process.exit(code);
  });
}

module.exports = { NESTED_ENV, mergeUsage, mergeWindow, passThrough, pickRateLimits, recordUsage, userStatusLine, withLock };

if (require.main === module) main();
