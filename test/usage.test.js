// 利用上限の使用率の表示のテストです。Claude Code は起動しません。
// ステータスラインのスクリプト（hooks/statusline.cjs）の取り出し・記録（同時に書くときの排他を含む）・表示の引き継ぎ（打ち切りを含む）、サーバでの記録の読み込み（lib/usage.js）、
// 画面の表示内容の組み立て（public/usage.js）を確かめます。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUsage, usageReader } from '../lib/usage.js';
import { USAGE_STALE_MS, formatAgo, formatClock, formatRemaining, formatUsd, usageLevel, usageReceivedLabel, usageRows } from '../public/usage.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'statusline.cjs');
const { NESTED_ENV, mergeUsage, mergeWindow, passThrough, pickRateLimits, recordUsage, userStatusLine, withLock } = createRequire(import.meta.url)(SCRIPT);

// 本番や開発用のデータ置き場、利用者の Claude Code の設定に触れないよう、すべて一時ディレクトリの中で確かめます
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-usage-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const freshDir = () => fs.mkdtempSync(path.join(tmp, `d${seq++}-`));
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
};

const RESET_5H = 1_800_000_000; // Unix 秒
const RESET_7D = 1_800_400_000;
const input = (rl) => ({ session_id: 's1', cwd: '/w', rate_limits: rl });
const win = (usedPercentage, resetsAt, receivedAt = 1000) => ({ usedPercentage, resetsAt, receivedAt });

// ---------- hooks/statusline.cjs ----------

test('rate_limits の 5 時間の枠・週の枠・利用額の上限を取り出し、リセットの時刻を Unix 秒からミリ秒にする', () => {
  const got = pickRateLimits(
    input({
      five_hour: { used_percentage: 12.5, resets_at: RESET_5H },
      seven_day: { used_percentage: 40, resets_at: RESET_7D },
      // Claude Code の文書に記載の形です（Claude apps ゲートウェイの利用額の上限）
      spend_limit: { used_percentage: 62.8, resets_at: RESET_7D, used_usd: 314.12, limit_usd: 500, period: 'monthly' },
    }),
    5000,
    'a1',
  );
  assert.deepEqual(got, {
    fiveHour: { usedPercentage: 12.5, resetsAt: RESET_5H * 1000, receivedAt: 5000, agentId: 'a1' },
    sevenDay: { usedPercentage: 40, resetsAt: RESET_7D * 1000, receivedAt: 5000, agentId: 'a1' },
    spendLimit: { usedPercentage: 62.8, resetsAt: RESET_7D * 1000, receivedAt: 5000, agentId: 'a1', usedUsd: 314.12, limitUsd: 500, period: 'monthly' },
  });
});

test('利用額の上限は、欠けた利用額や未知の期間を記録せず、使用率がなければ取り出さない', () => {
  const spend = (w) => pickRateLimits(input({ spend_limit: { used_percentage: 63, resets_at: RESET_7D, ...w } }), 1)?.spendLimit;
  // 利用額と期間は使用率より後に届くため、使用率とリセットの時刻だけでも記録します
  assert.deepEqual(spend({}), { usedPercentage: 63, resetsAt: RESET_7D * 1000, receivedAt: 1 });
  // 利用額は 2 つがそろって読めるときだけ記録します
  assert.deepEqual(Object.keys(spend({ used_usd: 1 })), ['usedPercentage', 'resetsAt', 'receivedAt']);
  assert.deepEqual(Object.keys(spend({ used_usd: '1', limit_usd: 2 })), ['usedPercentage', 'resetsAt', 'receivedAt']);
  assert.deepEqual(Object.keys(spend({ used_usd: -1, limit_usd: 2 })), ['usedPercentage', 'resetsAt', 'receivedAt']);
  // 期間は文書に記載の値だけを記録します
  assert.equal(spend({ period: 'yearly' }).period, undefined);
  assert.equal(spend({ period: 'daily' }).period, 'daily');
  // 上限を超えると使用率は 100 を超えます
  assert.equal(spend({ used_percentage: 112 }).usedPercentage, 112);
  assert.equal(pickRateLimits(input({ spend_limit: { used_usd: 1, limit_usd: 2 } }), 1), null);
  assert.equal(pickRateLimits(input({ spend_limit: 'x' }), 1), null);
});

test('rate_limits がない入力（API キーでの利用、最初の応答の前）や、読めない値の枠は取り出さない', () => {
  assert.equal(pickRateLimits({ session_id: 's1' }, 1), null);
  assert.equal(pickRateLimits(input(null), 1), null);
  assert.equal(pickRateLimits(input({}), 1), null);
  assert.equal(pickRateLimits(input({ five_hour: { used_percentage: 'x', resets_at: RESET_5H } }), 1), null);
  assert.equal(pickRateLimits(input({ five_hour: { used_percentage: null, resets_at: RESET_5H } }), 1), null);
  // 片方だけ読める場合は、読めるほうだけを取り出します
  assert.deepEqual(Object.keys(pickRateLimits(input({ five_hour: { resets_at: RESET_5H }, seven_day: { used_percentage: 3, resets_at: RESET_7D } }), 1)), ['sevenDay']);
});

test('同じ枠では使用率の高い値を残し、古い値で戻さない', () => {
  const now = win(30, 2_000_000, 100);
  // しばらく応答のないエージェントから、同じ枠の古い（低い）値が届いた場合です
  assert.equal(mergeWindow(now, win(20, 2_000_000, 200)), now);
  // 使用率が増えた値や、同じ値（受け取った時刻を更新する）は新しく受け取った値を使います
  const higher = win(35, 2_000_000, 200);
  assert.equal(mergeWindow(now, higher), higher);
  const same = win(30, 2_000_000, 200);
  assert.equal(mergeWindow(now, same), same);
  // 応答のないまま再描画されただけの同じ値では、受け取った時刻を進めません
  assert.equal(mergeWindow(now, same, { fresh: false }), now);
  assert.equal(mergeWindow(now, higher, { fresh: false }), higher);
  // リセットの時刻が少しずれていても同じ枠として扱います
  assert.equal(mergeWindow(now, win(10, 2_030_000, 200)), now);
});

test('リセットの時刻が後の枠（新しい枠）を優先し、前の枠の値は無視する', () => {
  const prev = win(90, 2_000_000, 100);
  const nextWindow = win(5, 2_000_000 + 5 * 3600_000, 200);
  assert.equal(mergeWindow(prev, nextWindow), nextWindow);
  assert.equal(mergeWindow(nextWindow, prev), nextWindow);
  assert.equal(mergeWindow(null, prev), prev);
  assert.equal(mergeWindow(prev, null), prev);
});

test('利用額の上限は、使用率だけの新しい値でも先に届いていた利用額を残す', () => {
  const dollars = { usedUsd: 300, limitUsd: 500, period: 'monthly' };
  const prev = { ...win(60, 9_000_000, 100), ...dollars };
  // 利用額は使用率より遅れて届くため、使用率だけが増えた値には同じ枠の利用額を引き継ぎます
  assert.deepEqual(mergeWindow(prev, win(63, 9_000_000, 200)), { ...win(63, 9_000_000, 200), ...dollars });
  // 古い（低い）使用率の値に新しい利用額があれば、残す値に引き継ぎます
  assert.deepEqual(mergeWindow(win(63, 9_000_000, 200), { ...win(60, 9_000_000, 300), ...dollars }), { ...win(63, 9_000_000, 200), ...dollars });
  // 利用額を持つ値を残す場合は、そのまま使います
  const next = { ...win(64, 9_000_000, 300), usedUsd: 320, limitUsd: 500 };
  assert.equal(mergeWindow(prev, next), next);
  // 新しい枠（期間が変わった）には、前の枠の利用額を引き継ぎません
  const nextWindow = win(1, 9_000_000 + 30 * 86400_000, 400);
  assert.equal(mergeWindow(prev, nextWindow), nextWindow);
});

test('記録の枠ごとに反映し、届かなかった枠と壊れた記録の枠を扱う', () => {
  const prev = { fiveHour: win(10, 2_000_000), sevenDay: win(50, 9_000_000) };
  const merged = mergeUsage(prev, { fiveHour: win(20, 2_000_000, 300) });
  assert.deepEqual(merged, { fiveHour: win(20, 2_000_000, 300), sevenDay: win(50, 9_000_000) });
  // 壊れた記録の枠は、ないものとして新しい値で置き換えます
  assert.deepEqual(mergeUsage({ fiveHour: { usedPercentage: 'x' } }, { fiveHour: win(1, 2, 3) }), { fiveHour: win(1, 2, 3) });
  assert.deepEqual(mergeUsage('broken', { sevenDay: win(1, 2, 3) }), { sevenDay: win(1, 2, 3) });
});

test('受け取った値を記録し、古い値が届いて記録が変わらない場合は書き込まない', () => {
  const file = path.join(freshDir(), 'usage.json');
  const rl = (pct) => input({ five_hour: { used_percentage: pct, resets_at: RESET_5H } });
  assert.equal(recordUsage(file, rl(30), { now: 1000, agentId: 'a1' }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { fiveHour: { usedPercentage: 30, resetsAt: RESET_5H * 1000, receivedAt: 1000, agentId: 'a1' }, seen: {} });
  assert.equal(recordUsage(file, rl(20), { now: 2000, agentId: 'a2' }), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fiveHour.agentId, 'a1');
  // rate_limits のない入力では、ほかのエージェントが受け取った値を消しません
  assert.equal(recordUsage(file, { session_id: 's' }, { now: 3000 }), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fiveHour.usedPercentage, 30);
});

test('受け取った時刻は、前回の実行から API の応答があったときだけ進める', () => {
  const file = path.join(freshDir(), 'usage.json');
  // cost.total_api_duration_ms は、そのプロセスが API の応答を待った時間の合計です
  const rl = (pct, apiMs) => ({ ...input({ five_hour: { used_percentage: pct, resets_at: RESET_5H } }), cost: { total_api_duration_ms: apiMs } });
  const receivedAt = () => JSON.parse(fs.readFileSync(file, 'utf8')).fiveHour.receivedAt;
  assert.equal(recordUsage(file, rl(30, 500), { now: 1000, agentId: 'a1' }), true);
  // 応答のないまま再描画された（値が同じ）場合は書き込まず、時刻も進めません
  assert.equal(recordUsage(file, rl(30, 500), { now: 2000, agentId: 'a1' }), false);
  assert.equal(receivedAt(), 1000);
  // 応答があれば、値が同じでも時刻を進めます
  assert.equal(recordUsage(file, rl(30, 900), { now: 3000, agentId: 'a1' }), true);
  assert.equal(receivedAt(), 3000);
  // 起動し直して数え直した（値が減った）場合も、応答があったものとして扱います
  assert.equal(recordUsage(file, rl(30, 100), { now: 4000, agentId: 'a1' }), true);
  assert.equal(receivedAt(), 4000);
  // ほかのエージェントの初めての実行は応答の後なので、同じ値でも時刻を進めます。その後の応答のない再描画では進めません
  assert.equal(recordUsage(file, rl(30, 50), { now: 5000, agentId: 'a2' }), true);
  assert.equal(receivedAt(), 5000);
  assert.equal(recordUsage(file, rl(30, 100), { now: 6000, agentId: 'a1' }), false);
  assert.equal(receivedAt(), 5000);
  // 応答があったか判断できない（応答の時間がない）場合は、時刻を進めません
  assert.equal(recordUsage(file, input({ five_hour: { used_percentage: 30, resets_at: RESET_5H } }), { now: 7000, agentId: 'a3' }), false);
  assert.equal(receivedAt(), 5000);
  // 使用率が増えた値は、応答の有無にかかわらず反映します
  assert.equal(recordUsage(file, rl(31, 100), { now: 8000, agentId: 'a1' }), true);
  assert.equal(receivedAt(), 8000);
});

test('利用額の上限を記録し、利用額が後から届いても使用率と合わせて残す', () => {
  const file = path.join(freshDir(), 'usage.json');
  const rl = (w, apiMs) => ({ ...input({ spend_limit: { resets_at: RESET_7D, ...w } }), cost: { total_api_duration_ms: apiMs } });
  assert.equal(recordUsage(file, rl({ used_percentage: 60 }, 100), { now: 1000, agentId: 'a1' }), true);
  assert.equal(recordUsage(file, rl({ used_percentage: 61, used_usd: 305, limit_usd: 500, period: 'monthly' }, 200), { now: 2000, agentId: 'a1' }), true);
  // ほかのエージェントから、利用額のない古い使用率が届いても戻しません
  assert.equal(recordUsage(file, rl({ used_percentage: 58 }, 50), { now: 3000, agentId: 'a2' }), true);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(rec.spendLimit, { usedPercentage: 61, resetsAt: RESET_7D * 1000, receivedAt: 2000, agentId: 'a1', usedUsd: 305, limitUsd: 500, period: 'monthly' });
  assert.deepEqual(normalizeUsage(rec).spendLimit, { usedPercentage: 61, resetsAt: RESET_7D * 1000, receivedAt: 2000, agentId: 'a1', usedUsd: 305, limitUsd: 500, period: 'monthly' });
});

test('ロックを取ってから処理し、終わったら解放する', () => {
  const lock = path.join(freshDir(), 'usage.json.lock');
  assert.equal(withLock(lock, () => (assert.ok(fs.existsSync(lock)), 'done')), 'done');
  assert.equal(fs.existsSync(lock), false);
  // 処理が例外を投げても解放します
  assert.throws(() => withLock(lock, () => { throw new Error('x'); }), /x/);
  assert.equal(fs.existsSync(lock), false);
});

test('ほかのプロセスがロックを持っていれば、待ち時間の上限で記録をあきらめる', () => {
  const file = path.join(freshDir(), 'usage.json');
  fs.writeFileSync(`${file}.lock`, 'other');
  const started = Date.now();
  assert.equal(recordUsage(file, input({ five_hour: { used_percentage: 1, resets_at: RESET_5H } }), { now: 1, agentId: 'a1', lock: { waitMs: 100 } }), false);
  // ステータスラインの表示を遅らせないよう、待ち続けません（余裕を見た上限です）
  assert.ok(Date.now() - started < 1000);
  assert.equal(fs.existsSync(file), false);
  // ほかのプロセスのロックは消しません
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), 'other');
  // 取り除けないロック（同じ名前のディレクトリ）があっても、待ち時間の上限で終わります
  const dirLock = path.join(freshDir(), 'usage.json.lock');
  fs.mkdirSync(dirLock);
  const t = Date.now();
  assert.equal(withLock(dirLock, () => true, { waitMs: 100, staleMs: 0 }), undefined);
  assert.ok(Date.now() - t < 1000);
});

test('持ち主が終了して残った古いロックは取り除いて記録する', () => {
  const file = path.join(freshDir(), 'usage.json');
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, 'dead');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(recordUsage(file, input({ five_hour: { used_percentage: 1, resets_at: RESET_5H } }), { now: 1, agentId: 'a1' }), true);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fiveHour.usedPercentage, 1);
});

test('時計が戻ってロックの更新時刻が未来になっても、古いロックとして取り除く', () => {
  const file = path.join(freshDir(), 'usage.json');
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, 'dead');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(lock, future, future);
  assert.equal(recordUsage(file, input({ five_hour: { used_percentage: 1, resets_at: RESET_5H } }), { now: 1, agentId: 'a1', lock: { waitMs: 100 } }), true);
  assert.equal(fs.existsSync(lock), false);
});

test('解放するとき、取り除かれた後に別のプロセスが取ったロックは消さない', () => {
  const lock = path.join(freshDir(), 'usage.json.lock');
  withLock(lock, () => fs.writeFileSync(lock, 'someone-else'));
  assert.equal(fs.readFileSync(lock, 'utf8'), 'someone-else');
});

/** 子プロセスを非同期に実行し、終了を待ちます。複数を同時に動かすために使います */
function runAsync(args, { env = {}, input: stdin = '' } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args, { env: { PATH: process.env.PATH, HOME: freshDir(), ...env }, cwd: freshDir() });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('exit', (code) => resolve({ code, stdout: out, stderr: err }));
    c.stdin.end(stdin);
  });
}

test('複数のエージェントが同時に記録しても、互いの更新を失わない', async () => {
  const file = path.join(freshDir(), 'usage.json');
  const procs = 6;
  const rounds = 30;
  // 各プロセスが自分のエージェントの応答（seen）を繰り返し記録します。排他がないと、読み込みから書き込みまでの間に
  // ほかのプロセスが書いた分を上書きし、最後の値が失われます。テストではロックを長く待たせ、あきらめによる取りこぼしを除きます
  const code = `
    const { recordUsage } = require(${JSON.stringify(SCRIPT)});
    const [file, id, rounds] = process.argv.slice(1);
    for (let i = 1; i <= Number(rounds); i++) {
      const input = { rate_limits: { five_hour: { used_percentage: 10, resets_at: ${RESET_5H} } }, cost: { total_api_duration_ms: i } };
      recordUsage(file, input, { now: Date.now(), agentId: id, lock: { waitMs: 20000 } });
    }`;
  const results = await Promise.all(Array.from({ length: procs }, (_, i) => runAsync(['-e', code, file, `a${i}`, String(rounds)])));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const seen = JSON.parse(fs.readFileSync(file, 'utf8')).seen;
  assert.deepEqual(
    Object.keys(seen).sort().map((id) => [id, seen[id].apiMs]),
    Array.from({ length: procs }, (_, i) => [`a${i}`, rounds]),
  );
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

// プロセスがなくなるまで待ちます（シグナルの配送は非同期のため、少しの間だけ確かめ続けます）
async function gone(pid, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') return true;
    }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}
const readPid = (file) => Number((fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) || 0);
const posixOnly = { skip: process.platform === 'win32' ? 'プロセスグループは POSIX のみです' : false };

test('利用者のコマンドを打ち切るとき、シェルが起動した孫プロセスも残さない', posixOnly, async () => {
  const dir = freshDir();
  const p1 = path.join(dir, 'p1');
  const p2 = path.join(dir, 'p2');
  // シェルがバックグラウンドとフォアグラウンドで 1 つずつ長いコマンドを起動します（どちらもこのテストから見て孫プロセスです）
  const command = `sleep 30 & echo $! > "${p1}"; sleep 31 & echo $! > "${p2}"; wait`;
  const started = Date.now();
  const code = await passThrough(command, '', { timeoutMs: 300, stdout: 'ignore', env: { PATH: process.env.PATH } });
  assert.equal(code, 0);
  // 打ち切りの上限（timeoutMs と強制終了までの猶予）の中で終わります
  assert.ok(Date.now() - started < 3000);
  for (const f of [p1, p2]) {
    const pid = readPid(f);
    assert.ok(pid > 0);
    assert.equal(await gone(pid), true, `孫プロセス ${pid} が残っています`);
  }
});

test('利用者のコマンドの終了コードを返し、入力を読まないコマンドでも落ちない', posixOnly, async () => {
  assert.equal(await passThrough('exit 3', 'x'.repeat(1 << 20), { stdout: 'ignore', env: { PATH: process.env.PATH } }), 3);
  assert.equal(await passThrough('true', '{}', { stdout: 'ignore', env: { PATH: process.env.PATH } }), 0);
});

test('打ち切りの後始末の途中で終了を求められても、SIGTERM を無視する孫プロセスを残さずに終わる', posixOnly, async () => {
  const pidFile = path.join(freshDir(), 'pid');
  // 孫プロセスは SIGTERM を無視するため、打ち切りでは SIGKILL まで待つ必要があります。
  // その猶予の間に、このプロセスが終了を求められる（Claude Code が次の更新で打ち切るなど）場合を再現します
  const command = `(trap '' TERM; exec sleep 40) & echo $! > "${pidFile}"; wait`;
  const code = `
    const { passThrough } = require(${JSON.stringify(SCRIPT)});
    passThrough(${JSON.stringify(command)}, '', { timeoutMs: 300, graceMs: 3000, stdout: 'ignore' }).then((c) => process.exit(c));`;
  const c = spawn(process.execPath, ['-e', code], { env: { PATH: process.env.PATH }, cwd: freshDir(), stdio: 'ignore' });
  const exited = new Promise((resolve) => c.on('exit', (code, signal) => resolve({ code, signal })));
  const end = Date.now() + 5000;
  while (!readPid(pidFile) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  const pid = readPid(pidFile);
  assert.ok(pid > 0);
  // 打ち切り（約 300 ミリ秒後）の後、SIGKILL を送る（約 3.3 秒後）より前に終了を求めます
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(await gone(pid, 0), false, '打ち切りの猶予の間は孫プロセスが残っているはずです');
  c.kill('SIGTERM');
  const result = await exited;
  // 失敗した場合も孫プロセスを残さないよう、確かめる前に片付けます
  const left = !(await gone(pid));
  if (left) process.kill(pid, 'SIGKILL');
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(left, false, `孫プロセス ${pid} が残っています`);
});

test('スクリプトが終了を求められたときも、利用者のコマンドの孫プロセスを残さずに終わる', posixOnly, async () => {
  const configDir = freshDir();
  const pidFile = path.join(freshDir(), 'pid');
  writeJson(path.join(configDir, 'settings.json'), { statusLine: { type: 'command', command: `sleep 30 & echo $! > "${pidFile}"; wait` } });
  const c = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, HOME: freshDir(), CLAUDE_CONFIG_DIR: configDir }, cwd: freshDir() });
  const exited = new Promise((resolve) => c.on('exit', (code, signal) => resolve({ code, signal })));
  c.stdin.end('{}');
  // 利用者のコマンドが孫プロセスを起動するまで待ちます
  const end = Date.now() + 5000;
  while (!readPid(pidFile) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  const pid = readPid(pidFile);
  assert.ok(pid > 0);
  // Claude Code は、更新のときに実行中のステータスラインのコマンドを打ち切ります
  c.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(await gone(pid), true, `孫プロセス ${pid} が残っています`);
});

test('ステータスラインの設定は、ローカル > プロジェクト > ユーザーの順に最初に見つかったものを使う', () => {
  const project = freshDir();
  const configDir = freshDir();
  const env = { CLAUDE_CONFIG_DIR: configDir };
  const homedir = freshDir();
  const sl = (command) => ({ statusLine: { type: 'command', command } });
  assert.equal(userStatusLine({ projectDir: project, env, homedir }), null);
  writeJson(path.join(configDir, 'settings.json'), sl('echo user'));
  assert.equal(userStatusLine({ projectDir: project, env, homedir }), 'echo user');
  writeJson(path.join(project, '.claude', 'settings.json'), sl('echo project'));
  assert.equal(userStatusLine({ projectDir: project, env, homedir }), 'echo project');
  writeJson(path.join(project, '.claude', 'settings.local.json'), sl('echo local'));
  assert.equal(userStatusLine({ projectDir: project, env, homedir }), 'echo local');
  // 不正な JSON や、コマンドでないステータスラインは、設定がないものとして次の候補を見ます
  writeJson(path.join(project, '.claude', 'settings.local.json'), '{ broken');
  writeJson(path.join(project, '.claude', 'settings.json'), { statusLine: { type: 'other', command: 'x' } });
  assert.equal(userStatusLine({ projectDir: project, env, homedir }), 'echo user');
  // CLAUDE_CONFIG_DIR がなければ、ホームの .claude を見ます
  writeJson(path.join(homedir, '.claude', 'settings.json'), sl('echo home'));
  assert.equal(userStatusLine({ projectDir: project, env: {}, homedir }), 'echo home');
});

/** スクリプトを子プロセスで実行します。HOME と CLAUDE_CONFIG_DIR を一時ディレクトリにし、利用者の設定を読まないようにします */
function runScript(stdin, { env = {}, configDir = freshDir() } = {}) {
  // 作業ディレクトリも一時ディレクトリにし、リポジトリの .claude/settings*.json を読まないようにします
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: stdin,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: freshDir(), CLAUDE_CONFIG_DIR: configDir, ...env },
    cwd: freshDir(),
    timeout: 10000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('スクリプトは使用率を記録し、利用者のステータスラインに同じ入力を渡して出力をそのまま表示する', () => {
  const home = freshDir();
  const project = freshDir();
  // 渡された入力を読んで表示するコマンドです。入力がそのまま渡っているかを確かめるため、session_id を表示させます
  const reader = path.join(project, 'show.cjs');
  fs.writeFileSync(reader, "let s='';process.stdin.on('data',(c)=>s+=c).on('end',()=>process.stdout.write('user:'+JSON.parse(s).session_id+'\\n'+process.cwd()));\n");
  writeJson(path.join(project, '.claude', 'settings.json'), { statusLine: { type: 'command', command: `"${process.execPath}" "${reader}"` } });
  const stdin = JSON.stringify({ ...input({ seven_day: { used_percentage: 42, resets_at: RESET_7D } }), workspace: { project_dir: project } });
  const r = runScript(stdin, { env: { AGENT_HUB_HOME: home, AGENT_HUB_AGENT: 'a1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^user:s1\n/);
  const rec = JSON.parse(fs.readFileSync(path.join(home, 'usage.json'), 'utf8'));
  assert.equal(rec.sevenDay.usedPercentage, 42);
  assert.equal(rec.sevenDay.agentId, 'a1');
});

test('利用者のステータスラインがなければ何も表示せず、終了コード 0 で終わる', () => {
  const home = freshDir();
  const r = runScript(JSON.stringify(input({ five_hour: { used_percentage: 1, resets_at: RESET_5H } })), { env: { AGENT_HUB_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.ok(fs.existsSync(path.join(home, 'usage.json')));
});

test('workspace.project_dir がない入力では、現在のディレクトリ（cwd）の設定を使わず、利用者の設定だけを見る', () => {
  const configDir = freshDir();
  writeJson(path.join(configDir, 'settings.json'), { statusLine: { type: 'command', command: 'echo user' } });
  const project = freshDir();
  writeJson(path.join(project, '.claude', 'settings.local.json'), { statusLine: { type: 'command', command: 'echo project' } });
  // cwd は作業中に移動した別の場所を指しうるため、Claude Code が本来読まない設定のコマンドを実行しないようにします
  assert.equal(runScript(JSON.stringify({ cwd: project }), { configDir }).stdout, 'user\n');
  assert.equal(runScript(JSON.stringify({ cwd: project, workspace: { project_dir: project } }), { configDir }).stdout, 'project\n');
});

test('入力が不正でもデータ置き場がなくても落ちず、利用者のステータスラインは表示する', () => {
  const configDir = freshDir();
  writeJson(path.join(configDir, 'settings.json'), { statusLine: { type: 'command', command: 'echo shown' } });
  for (const env of [{}, { AGENT_HUB_HOME: path.join(freshDir(), 'file') }]) {
    if (env.AGENT_HUB_HOME) fs.writeFileSync(env.AGENT_HUB_HOME, ''); // ディレクトリを作れない場所です
    const r = runScript('not json', { env, configDir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'shown\n');
  }
});

test('利用者の設定がこのスクリプト自身を指していても、呼び出しを繰り返さない', () => {
  const configDir = freshDir();
  writeJson(path.join(configDir, 'settings.json'), { statusLine: { type: 'command', command: `"${process.execPath}" "${SCRIPT}"; echo once` } });
  const r = runScript('{}', { configDir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'once\n');
  // 呼び出された側では利用者のコマンドを実行しません
  const nested = runScript('{}', { configDir, env: { [NESTED_ENV]: '1' } });
  assert.equal(nested.stdout, '');
});

// ---------- lib/usage.js ----------

test('記録を画面に配る形にし、読めない記録は null にする', () => {
  assert.deepEqual(normalizeUsage({ fiveHour: { ...win(10, 20, 30), agentId: 'a1', extra: 1 } }), { fiveHour: { ...win(10, 20, 30), agentId: 'a1' }, sevenDay: null, spendLimit: null });
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ fiveHour: { usedPercentage: '1', resetsAt: 2, receivedAt: 3 } }), null);
});

test('利用額の上限は、読める利用額と既知の期間だけを配り、利用額の上限だけの記録も配る', () => {
  const spend = (w) => normalizeUsage({ spendLimit: { ...win(63, 20, 30), ...w } });
  assert.deepEqual(spend({ usedUsd: 314.12, limitUsd: 500, period: 'monthly', extra: 1 }), {
    fiveHour: null,
    sevenDay: null,
    spendLimit: { ...win(63, 20, 30), usedUsd: 314.12, limitUsd: 500, period: 'monthly' },
  });
  // 片方だけの利用額・数値でない利用額・未知の期間は配りません
  assert.deepEqual(spend({ usedUsd: 1 }).spendLimit, win(63, 20, 30));
  assert.deepEqual(spend({ usedUsd: 1, limitUsd: '2' }).spendLimit, win(63, 20, 30));
  assert.deepEqual(spend({ usedUsd: Infinity, limitUsd: 2 }).spendLimit, win(63, 20, 30));
  assert.deepEqual(spend({ period: 'yearly' }).spendLimit, win(63, 20, 30));
  assert.equal(normalizeUsage({ spendLimit: { usedPercentage: 1 } }), null);
});

test('記録の読み込みは、ファイルが変わったときだけ内容の変化を知らせる', () => {
  const file = path.join(freshDir(), 'usage.json');
  const r = usageReader(file);
  assert.equal(r.refresh(), false); // 記録がないまま（null のまま）です
  assert.equal(r.current(), null);
  writeJson(file, { fiveHour: win(10, 20, 30) });
  assert.equal(r.refresh(), true);
  assert.equal(r.current().fiveHour.usedPercentage, 10);
  assert.equal(r.refresh(), false);
  // 実際の記録と同じく名前の付け替えで書き換えます（更新時刻の分解能に頼らずに変化を見分けられるようにするためです）
  writeJson(`${file}.tmp`, { fiveHour: win(11, 20, 31) });
  fs.renameSync(`${file}.tmp`, file);
  assert.equal(r.refresh(), true);
  assert.equal(r.current().fiveHour.usedPercentage, 11);
  // 読めない内容のときは、前の値を残します
  writeJson(`${file}.tmp`, '{"fiveHour":');
  fs.renameSync(`${file}.tmp`, file);
  assert.equal(r.refresh(), false);
  assert.equal(r.current().fiveHour.usedPercentage, 11);
  fs.rmSync(file);
  assert.equal(r.refresh(), true);
  assert.equal(r.current(), null);
});

// ---------- public/usage.js ----------

// 時刻の表記はブラウザの地域の時刻で行うため、テストでも地域の時刻で日時を作ります
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

test('残り時間・時刻・経過の表記', () => {
  assert.equal(formatRemaining(30 * 1000), '1分未満');
  assert.equal(formatRemaining(45 * 60000), '45分');
  assert.equal(formatRemaining(2 * 3600000), '2時間');
  assert.equal(formatRemaining((2 * 60 + 13) * 60000), '2時間13分');
  assert.equal(formatRemaining((3 * 24 + 4) * 3600000 + 59000), '3日4時間');
  assert.equal(formatRemaining(-1), '1分未満');
  assert.equal(formatClock(at(12, 15, 5), at(12, 10)), '15:05');
  assert.equal(formatClock(at(15, 9), at(12, 10)), '11/15 9:00');
  assert.equal(formatAgo(at(12, 10), at(12, 10) + 59000), 'たった今');
  assert.equal(formatAgo(at(12, 10), at(12, 10, 3)), '3分前');
  assert.equal(formatAgo(at(12, 10), at(12, 13)), '3時間前');
  assert.equal(formatAgo(at(10, 10), at(12, 10)), '2日前');
});

test('使用率の段階は 70% から注意、90% から警告にする', () => {
  assert.equal(usageLevel(69.9), 'ok');
  assert.equal(usageLevel(70), 'warn');
  assert.equal(usageLevel(90), 'high');
});

test('値のある枠はバーを、値のない枠は「不明」を、リセットを過ぎた枠は「リセット済み」を表示する', () => {
  const now = at(12, 10);
  const rows = usageRows({ fiveHour: win(62.4, at(12, 12, 13), now - 60000), sevenDay: null }, now);
  assert.deepEqual(
    rows.map(({ key, status, percent, width, level, text, reset, stale }) => ({ key, status, percent, width, level, text, reset, stale })),
    [
      { key: 'fiveHour', status: 'ok', percent: 62, width: 62.4, level: 'ok', text: '62%', reset: '12:13 にリセット（あと2時間13分）', stale: false },
      { key: 'sevenDay', status: 'unknown', percent: undefined, width: undefined, level: undefined, text: '不明', reset: undefined, stale: undefined },
    ],
  );
  assert.match(rows[0].title, /受け取り: 9:59（1分前）/);
  const reset = usageRows({ fiveHour: win(80, at(12, 9), at(12, 8)) }, now)[0];
  assert.equal(reset.status, 'reset');
  assert.equal(reset.text, 'リセット済み');
  assert.equal(reset.percent, undefined);
  // 100% を超える値や負の値でも、バーの幅は枠の中に収めます
  assert.equal(usageRows({ fiveHour: win(130, at(12, 12), now) }, now)[0].width, 100);
  assert.equal(usageRows({ fiveHour: win(-5, at(12, 12), now) }, now)[0].width, 0);
  assert.equal(usageRows(null, now).every((r) => r.status === 'unknown'), true);
});

test('利用額の上限は、値があるときだけ 5 時間の枠・週の枠の後に同じ形で表示する', () => {
  const now = at(12, 10);
  const plan = { fiveHour: win(10, at(12, 12), now), sevenDay: win(20, at(15, 9), now) };
  // 値がない環境では従来どおり 2 つの枠だけです
  assert.deepEqual(usageRows(plan, now).map((r) => r.key), ['fiveHour', 'sevenDay']);
  const spend = { usedPercentage: 62.8, resetsAt: at(30, 9), receivedAt: now - 60000, usedUsd: 314.12, limitUsd: 500, period: 'monthly' };
  const rows = usageRows({ ...plan, spendLimit: spend }, now);
  assert.deepEqual(rows.map((r) => r.key), ['fiveHour', 'sevenDay', 'spendLimit']);
  const r = rows[2];
  assert.deepEqual(
    { label: r.label, status: r.status, percent: r.percent, width: r.width, level: r.level, text: r.text, detail: r.detail, reset: r.reset, ariaLabel: r.ariaLabel },
    { label: '利用額', status: 'ok', percent: 63, width: 62.8, level: 'ok', text: '63%', detail: '$314.12 / $500（月ごと）', reset: '11/30 9:00 にリセット（あと17日23時間）', ariaLabel: '利用額の上限（月ごと）の使用率' },
  );
  assert.match(r.title, /^利用額の上限（月ごと）: 63% 使用\n\$314\.12 \/ \$500（推定。/);
  assert.equal(rows[0].ariaLabel, '5 時間の枠の使用率');
  // 利用額と期間がまだ届いていない場合は、使用率とリセットの時刻だけを表示します
  const pctOnly = usageRows({ ...plan, spendLimit: { usedPercentage: 63, resetsAt: at(30, 9), receivedAt: now } }, now)[2];
  assert.equal(pctOnly.reset, '11/30 9:00 にリセット（あと17日23時間）');
  assert.equal(pctOnly.detail, undefined);
  // 期間が分からない場合は、利用額だけを表示します
  assert.equal(usageRows({ spendLimit: { ...spend, period: undefined } }, now)[0].detail, '$314.12 / $500');
  // 5 時間の枠・週の枠には補足を付けません
  assert.equal(rows[0].detail, undefined);
  assert.match(pctOnly.title, /^利用額の上限: 63% 使用\n11\/30/);
  // 上限を超えた場合は、使用率をそのまま表記し、バーは枠の中に収めて警告の色にします
  const over = usageRows({ spendLimit: { ...spend, usedPercentage: 112.4 } }, now)[0];
  assert.deepEqual([over.text, over.width, over.level], ['112%', 100, 'high']);
  // リセットを過ぎた場合は、ほかの枠と同じく「リセット済み」にします
  assert.equal(usageRows({ ...plan, spendLimit: { ...spend, resetsAt: now - 1 } }, now)[2].status, 'reset');
});

test('利用額の上限だけがある場合は、5 時間の枠・週の枠を「不明」として並べない', () => {
  const now = at(12, 10);
  const spendLimit = { usedPercentage: 10, resetsAt: at(13, 0), receivedAt: now - 2 * 60000 };
  assert.deepEqual(usageRows({ fiveHour: null, sevenDay: null, spendLimit }, now).map((r) => r.key), ['spendLimit']);
  // どちらかの枠があれば、ないほうは従来どおり「不明」と表示します
  assert.deepEqual(usageRows({ fiveHour: win(1, at(12, 12), now), sevenDay: null, spendLimit }, now).map((r) => r.text), ['1%', '不明', '10%']);
  assert.equal(usageReceivedLabel({ spendLimit }, now), '受け取り: 2分前');
});

test('米ドルの金額の表記', () => {
  assert.equal(formatUsd(500), '$500');
  assert.equal(formatUsd(314.1), '$314.10');
  assert.equal(formatUsd(1234.567), '$1,234.57');
  assert.equal(formatUsd(0), '$0');
});

test('受け取ってから時間がたった値は古い値として示す', () => {
  const now = at(12, 10);
  const fresh = usageRows({ fiveHour: win(10, at(12, 12), now - USAGE_STALE_MS) }, now)[0];
  const old = usageRows({ fiveHour: win(10, at(12, 12), now - USAGE_STALE_MS - 1) }, now)[0];
  assert.equal(fresh.stale, false);
  assert.equal(old.stale, true);
  assert.match(old.title, /反映されていない場合があります/);
  assert.equal(usageReceivedLabel({ fiveHour: win(1, 2, now - 5 * 60000), sevenDay: win(1, 2, now - 2 * 60000) }, now), '受け取り: 2分前');
  assert.equal(usageReceivedLabel(null, now), '');
});
