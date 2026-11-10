// scripts/dev.mjs のテストです。開発用ハブに渡す環境変数の決め方（特にハブが起動したエージェントの中で
// 実行した場合の AGENT_HUB_HOME の扱い）を確かめます。
// 利用者のホームの実際のパスには触れないよう、ホームディレクトリを一時ディレクトリに差し替えて行います。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDirectRun, isLaunchedFrom, resolveDevEnv } from '../scripts/dev.mjs';
import { pathToFileURL } from 'node:url';

const AGENT = 'a1234567';

/** テストごとの一時ホームディレクトリを作り、終了時に消します */
function tmpHome(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dev-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** ハブがエージェントを起動したあとのデータ置き場を再現します（hook がイベントを書いた状態） */
function hubWithAgentEvents(home, id = AGENT) {
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  fs.writeFileSync(path.join(home, 'events', `${id}.jsonl`), '{"event":"SessionStart"}\n');
  return home;
}

/** ハブがエージェントを登録しただけの状態（イベントがまだない）を再現します */
function hubWithAgentEntry(home, id = AGENT) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify([{ id: 'other' }, { id }]));
  return home;
}

test('エージェントの外では、指定がなければ開発用の既定値を使う', (t) => {
  const h = tmpHome(t);
  const { env, problems } = resolveDevEnv({ PATH: '/bin' }, { homedir: h });
  assert.deepEqual(problems, []);
  assert.equal(env.HUB_PORT, '4400');
  assert.equal(env.AGENT_HUB_HOME, path.join(h, '.agent-hub-dev'));
  assert.equal(env.HUB_TMUX_SESSION, 'agent-hub-dev');
  assert.equal(env.PATH, '/bin');
});

test('エージェントの外では、指定した AGENT_HUB_HOME をそのまま使う', (t) => {
  const h = tmpHome(t);
  const home = path.join(h, '.agent-hub-dev2');
  const { env, problems } = resolveDevEnv({ AGENT_HUB_HOME: home }, { homedir: h });
  assert.deepEqual(problems, []);
  assert.equal(env.AGENT_HUB_HOME, home);
});

test('本番のハブから引き継いだ AGENT_HUB_HOME は使わず、開発用の既定値に置き換える', (t) => {
  const h = tmpHome(t);
  const prod = hubWithAgentEvents(path.join(h, '.agent-hub'));
  const { env, notes, problems } = resolveDevEnv({ AGENT_HUB_AGENT: AGENT, AGENT_HUB_HOME: prod }, { homedir: h });
  assert.deepEqual(problems, []);
  assert.equal(env.AGENT_HUB_HOME, path.join(h, '.agent-hub-dev'));
  assert.equal(env.AGENT_HUB_AGENT, undefined);
  assert.ok(notes.some((n) => n.includes(prod) && n.includes('使用しません')), notes.join('\n'));
});

test('エージェントの中でも、親のハブと別のデータ置き場を指定すればその値を使う', (t) => {
  const h = tmpHome(t);
  hubWithAgentEvents(path.join(h, '.agent-hub'));
  const mine = path.join(h, '.agent-hub-dev2');
  const { env, notes, problems } = resolveDevEnv({ AGENT_HUB_AGENT: AGENT, AGENT_HUB_HOME: mine }, { homedir: h });
  assert.deepEqual(problems, []);
  assert.equal(env.AGENT_HUB_HOME, mine);
  assert.equal(env.AGENT_HUB_AGENT, undefined);
  assert.ok(notes.some((n) => n.includes(mine) && n.includes('使用します')), notes.join('\n'));
});

test('開発用のハブから引き継いだ AGENT_HUB_HOME も、親のデータ置き場として使わない', (t) => {
  const h = tmpHome(t);
  const parent = hubWithAgentEvents(path.join(h, '.agent-hub-dev2'));
  const { env, problems } = resolveDevEnv({ AGENT_HUB_AGENT: AGENT, AGENT_HUB_HOME: parent }, { homedir: h });
  assert.deepEqual(problems, []);
  assert.equal(env.AGENT_HUB_HOME, path.join(h, '.agent-hub-dev'));
});

test('イベントがまだなくても、agents.json に登録されていれば親のデータ置き場とみなす', (t) => {
  const h = tmpHome(t);
  const parent = hubWithAgentEntry(path.join(h, '.agent-hub-dev2'));
  const { env, problems } = resolveDevEnv({ AGENT_HUB_AGENT: AGENT, AGENT_HUB_HOME: parent }, { homedir: h });
  assert.deepEqual(problems, []);
  assert.equal(env.AGENT_HUB_HOME, path.join(h, '.agent-hub-dev'));
});

test('既定値のデータ置き場が親のハブのものなら、共有しないよう起動を拒否する', (t) => {
  const h = tmpHome(t);
  const parent = hubWithAgentEvents(path.join(h, '.agent-hub-dev'));
  const { problems } = resolveDevEnv({ AGENT_HUB_AGENT: AGENT, AGENT_HUB_HOME: parent }, { homedir: h });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /このエージェントを起動したハブのデータ置き場/);
});

test('本番と同じ値を指定した場合は、エージェントの外では起動を拒否する', (t) => {
  const h = tmpHome(t);
  const { problems } = resolveDevEnv(
    { HUB_PORT: '4317', AGENT_HUB_HOME: path.join(h, '.agent-hub'), HUB_TMUX_SESSION: 'agent-hub' },
    { homedir: h },
  );
  assert.equal(problems.length, 3);
});

test('開発用のハブが起動したエージェントの中で本番のデータ置き場を指定した場合も、起動を拒否する', (t) => {
  const h = tmpHome(t);
  hubWithAgentEvents(path.join(h, '.agent-hub-dev2'));
  const prod = path.join(h, '.agent-hub');
  const { problems } = resolveDevEnv({ AGENT_HUB_AGENT: AGENT, AGENT_HUB_HOME: prod }, { homedir: h });
  assert.deepEqual(problems, [`AGENT_HUB_HOME が本番と同じ ${prod} です`]);
});

test('isLaunchedFrom は agents.json が壊れている・配列でない場合に、親のデータ置き場とみなさない', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dev-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(isLaunchedFrom(home, AGENT), false, 'agents.json がない');
  fs.writeFileSync(path.join(home, 'agents.json'), '{ broken');
  assert.equal(isLaunchedFrom(home, AGENT), false, 'JSON として読めない');
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify({ id: AGENT }));
  assert.equal(isLaunchedFrom(home, AGENT), false, '配列でない');
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify([null, 1, { id: 'other' }]));
  assert.equal(isLaunchedFrom(home, AGENT), false, '要素が想定外の形');
  assert.equal(isLaunchedFrom('', AGENT), false, 'データ置き場が空');
  assert.equal(isLaunchedFrom(home, ''), false, 'エージェント ID が空');
});

test('isDirectRun はシンボリックリンクを含むパスで実行した場合も、直接実行と判定する', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dev-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  const file = path.join(real, 'dev.mjs');
  fs.writeFileSync(file, '');
  const link = path.join(dir, 'link');
  fs.symlinkSync(real, link, 'dir');
  const url = pathToFileURL(file).href;
  assert.equal(isDirectRun(file, url), true, '実体のパス');
  assert.equal(isDirectRun(path.join(link, 'dev.mjs'), url), true, 'リンクを含むパス');
  assert.equal(isDirectRun(path.join(dir, 'other.mjs'), url), false, '別のファイル');
  assert.equal(isDirectRun(undefined, url), false, '引数なし（import された場合など）');
});
