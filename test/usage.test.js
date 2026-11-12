// 利用上限の使用率の表示のテストです。Claude Code は起動しません。
// ステータスラインのスクリプト（hooks/statusline.cjs）の取り出し・記録・表示の引き継ぎ、サーバでの記録の読み込み（lib/usage.js）、
// 画面の表示内容の組み立て（public/usage.js）を確かめます。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUsage, usageReader } from '../lib/usage.js';
import { USAGE_STALE_MS, formatAgo, formatClock, formatRemaining, usageLevel, usageReceivedLabel, usageRows } from '../public/usage.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'statusline.cjs');
const { NESTED_ENV, mergeUsage, mergeWindow, pickRateLimits, recordUsage, userStatusLine } = createRequire(import.meta.url)(SCRIPT);

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

test('rate_limits の 5 時間の枠と週の枠を取り出し、リセットの時刻を Unix 秒からミリ秒にする', () => {
  const got = pickRateLimits(
    input({ five_hour: { used_percentage: 12.5, resets_at: RESET_5H }, seven_day: { used_percentage: 40, resets_at: RESET_7D }, spend_limit: { used_percentage: 1, resets_at: 1 } }),
    5000,
    'a1',
  );
  assert.deepEqual(got, {
    fiveHour: { usedPercentage: 12.5, resetsAt: RESET_5H * 1000, receivedAt: 5000, agentId: 'a1' },
    sevenDay: { usedPercentage: 40, resetsAt: RESET_7D * 1000, receivedAt: 5000, agentId: 'a1' },
  });
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
  assert.deepEqual(normalizeUsage({ fiveHour: { ...win(10, 20, 30), agentId: 'a1', extra: 1 } }), { fiveHour: { ...win(10, 20, 30), agentId: 'a1' }, sevenDay: null });
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ fiveHour: { usedPercentage: '1', resetsAt: 2, receivedAt: 3 } }), null);
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
