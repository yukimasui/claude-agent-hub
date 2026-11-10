// scripts/dev.mjs のテストです。開発用ハブに渡す環境変数の決め方（特にハブが起動したエージェントの中で
// 実行した場合の AGENT_HUB_HOME の扱い）を確かめます。
// 利用者のホームの実際のパスには触れないよう、ホームディレクトリを一時ディレクトリに差し替えて行います。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDevEnv } from '../scripts/dev.mjs';

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
