// エフォートの随時変更のテストです。変更できるかどうかの判定（public/effort.js）と、
// TUI で実行された /effort の結果を transcript から読み取る処理（lib/transcript.js）を確かめます。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EFFORT_LEVELS, effortChangeBlockReason, effortToFollow, isEffortValue } from '../public/effort.js';
import { effortFromCommandOutput, readEffortChange } from '../lib/transcript.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-effort-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** 待機中で、変更できる状態のエージェントを基本に、指定したフィールドだけを変えたものを作ります */
const agent = (fields = {}) => ({ alive: true, state: 'idle', pending: [], subagents: [], handoff: null, effort: '', ...fields });

// ---------- 選択肢 ----------

test('受け付ける値は作成フォームと同じ選択肢（空文字の「ユーザー設定に従う」を含む）だけにする', () => {
  assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const v of ['', ...EFFORT_LEVELS]) assert.equal(isEffortValue(v), true, v);
  for (const v of ['auto', 'ultracode', 'HIGH', null, undefined, 3]) assert.equal(isEffortValue(v), false, String(v));
});

// ---------- 変更できるかどうか ----------

test('待機中・応答完了のときだけ変更できる', () => {
  assert.equal(effortChangeBlockReason(agent({ state: 'idle' })), null);
  assert.equal(effortChangeBlockReason(agent({ state: 'done' })), null);
  for (const state of ['starting', 'running', 'waiting', 'compacting', 'ended']) {
    assert.match(effortChangeBlockReason(agent({ state })), /応答完了.*待機中/, state);
  }
});

test('回答待ちの要求がある間は、状態にかかわらず変更できない', () => {
  assert.match(effortChangeBlockReason(agent({ state: 'idle', pending: [{ reqId: 'r1' }] })), /回答待ち/);
});

test('サブエージェントが実行中か要対応の間は変更できず、終わったものだけなら変更できる', () => {
  assert.match(effortChangeBlockReason(agent({ subagents: [{ state: 'done' }, { state: 'running' }] })), /サブエージェント/);
  assert.match(effortChangeBlockReason(agent({ subagents: [{ state: 'waiting' }] })), /サブエージェント/);
  assert.equal(effortChangeBlockReason(agent({ subagents: [{ state: 'done' }, { state: 'failed' }, { state: 'ended' }] })), null);
});

test('「引き継いでリセット」の実行中は変更できず、結果の表示だけなら変更できる', () => {
  assert.match(effortChangeBlockReason(agent({ handoff: { stage: 'memo' } })), /引き継いでリセット/);
  assert.match(effortChangeBlockReason(agent({ handoff: { stage: 'clear' } })), /引き継いでリセット/);
  assert.equal(effortChangeBlockReason(agent({ handoff: { stage: 'done' } })), null);
});

test('プロセスが終了しているときは、保存値だけを変えるのでいつでも変更できる', () => {
  assert.equal(effortChangeBlockReason(agent({ alive: false, state: 'ended' })), null);
  assert.equal(effortChangeBlockReason(agent({ alive: false, state: 'running', pending: [{ reqId: 'r1' }] })), null);
  assert.match(effortChangeBlockReason(null), /選択されていません/);
});

// ---------- /effort の出力の読み取り ----------

test('/effort が変更に成功したときの出力から、変更後のレベルを読み取る', () => {
  // Claude Code 2.1.322 の実際の出力です
  assert.equal(
    effortFromCommandOutput('Set effort level to high (saved as your default for new sessions): Comprehensive implementation with extensive testing and documentation'),
    'high',
  );
  assert.equal(effortFromCommandOutput('Set effort level to max (this session only): Maximum capability with deepest reasoning.'), 'max');
  assert.equal(effortFromCommandOutput('Set effort level to xhigh (saved as your default for new sessions): Deeper reasoning'), 'xhigh');
  assert.equal(effortFromCommandOutput("Effort 'max' exceeds the cap for claude-haiku set by your settings or organization; set to 'high' instead (this session only): …"), 'high');
  // 色付けのエスケープシーケンスが混ざっていても読み取ります
  assert.equal(effortFromCommandOutput('\x1b[1mSet effort level to low\x1b[22m (this session only): Quick'), 'low');
});

test('/effort auto の成功は「ユーザー設定に従う」（空文字）として読み取る', () => {
  assert.equal(effortFromCommandOutput('Effort level set to auto'), '');
  assert.equal(effortFromCommandOutput('Effort level set to auto (this session only)'), '');
});

test('変更に失敗した出力や、セッションで効いていない出力、現在の値の表示は読み取らない', () => {
  for (const text of [
    'Invalid argument: extreme. Valid options are: low, medium, high, xhigh, max, auto',
    'Failed to set effort level: EACCES',
    'Not applied: CLAUDE_CODE_EFFORT_LEVEL=low overrides effort this session, and max is session-only (nothing saved)',
    'CLAUDE_CODE_EFFORT_LEVEL=low overrides this session — clear it and high takes over',
    'Effort set to auto for this session, but CLAUDE_CODE_EFFORT_LEVEL=low still controls this session',
    'Cleared effort from settings, but CLAUDE_CODE_EFFORT_LEVEL=low still controls this session',
    'Current effort level: high (Comprehensive implementation)',
    'Effort level: auto (currently medium)',
    'Usage: /effort <low|medium|high|xhigh|max|auto>',
    'Ultracode off. Effort stays high.',
    'Set effort level to 42',
    '',
  ]) {
    assert.equal(effortFromCommandOutput(text), undefined, text);
  }
});

// ---------- transcript からの読み取り ----------

const cmdLine = (name, args, ts, extra = {}) => ({
  type: 'user',
  timestamp: ts,
  message: { role: 'user', content: `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>` },
  ...extra,
});
const outLine = (text, ts, extra = {}) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` }, ...extra });
const jsonl = (...lines) => lines.map((l) => JSON.stringify(l) + '\n').join('');
const T1 = '2026-11-12T01:00:00.000Z';
const T2 = '2026-11-12T01:05:00.000Z';
const T3 = '2026-11-12T01:10:00.000Z';

test('TUI で実行した /effort の結果を、追記された分から読み取り、最後に成功したものを返す', () => {
  const file = path.join(dir, 'tui.jsonl');
  assert.equal(readEffortChange(file), null); // まだファイルがありません
  assert.equal(readEffortChange(null), null);
  fs.writeFileSync(file, jsonl({ type: 'user', timestamp: T1, message: { role: 'user', content: 'こんにちは' } }));
  assert.equal(readEffortChange(file), null);

  fs.appendFileSync(file, jsonl(cmdLine('/effort', 'high', T1), outLine('Set effort level to high (saved as your default for new sessions): …', T1)));
  assert.deepEqual(readEffortChange(file), { value: 'high', at: Date.parse(T1) });

  // 失敗した実行では、前の成功を返したままにします
  fs.appendFileSync(file, jsonl(cmdLine('/effort', 'extreme', T2), outLine('Invalid argument: extreme. Valid options are: low, medium, high, xhigh, max, auto', T2)));
  assert.deepEqual(readEffortChange(file), { value: 'high', at: Date.parse(T1) });

  // 書きかけの行は、改行が書かれてから読みます
  const rest = jsonl(cmdLine('/effort', 'auto', T3), outLine('Effort level set to auto', T3));
  fs.appendFileSync(file, rest.slice(0, rest.length - 10));
  assert.deepEqual(readEffortChange(file), { value: 'high', at: Date.parse(T1) });
  fs.appendFileSync(file, rest.slice(rest.length - 10));
  assert.deepEqual(readEffortChange(file), { value: '', at: Date.parse(T3) });
});

test('直前のコマンドが /effort でない出力や、サブエージェント内の行は読み取らない', () => {
  const file = path.join(dir, 'other.jsonl');
  fs.writeFileSync(
    file,
    jsonl(
      cmdLine('/model', 'haiku', T1),
      outLine('Set effort level to low (this session only)', T1),
      cmdLine('/effort', 'max', T2, { isSidechain: true }),
      outLine('Set effort level to max (this session only)', T2, { isSidechain: true }),
      // 出力の前に別のコマンドが挟まった場合も、/effort の出力とはみなしません
      cmdLine('/effort', 'low', T3),
      cmdLine('/model', 'opus', T3),
      outLine('Set effort level to low (this session only)', T3),
    ),
  );
  assert.equal(readEffortChange(file), null);
});

test('作り直された（短くなった）transcript は最初から読み直す', () => {
  const file = path.join(dir, 'recreated.jsonl');
  fs.writeFileSync(file, jsonl(cmdLine('/effort', 'high', T1), outLine('Set effort level to high (this session only)', T1), { type: 'user', timestamp: T1, message: { content: 'x'.repeat(200) } }));
  assert.equal(readEffortChange(file).value, 'high');
  fs.writeFileSync(file, jsonl(cmdLine('/effort', 'low', T2), outLine('Set effort level to low (this session only)', T2)));
  assert.deepEqual(readEffortChange(file), { value: 'low', at: Date.parse(T2) });
});

// ---------- 保存値への反映 ----------

test('今のプロセスで、ハブから変更した後に実行された /effort だけを保存値に反映する', () => {
  const at = Date.parse(T2);
  const change = { value: 'high', at };
  assert.equal(effortToFollow(agent({ processStartedAt: at - 1000 }), change), 'high');
  assert.equal(effortToFollow(agent({ processStartedAt: at - 1000 }), { value: '', at }), undefined); // 保存値と同じです
  assert.equal(effortToFollow(agent({ effort: 'low', processStartedAt: at - 1000 }), { value: '', at }), '');
  // 前のプロセスでの実行は、起動し直した時点で --effort に置き換わっています
  assert.equal(effortToFollow(agent({ processStartedAt: at + 1 }), change), undefined);
  // プロセスの終了中などにハブから変えた後は、それより前の実行で値を戻しません
  assert.equal(effortToFollow(agent({ effort: 'low', processStartedAt: at - 1000, effortSetAt: at }), change), undefined);
  assert.equal(effortToFollow(agent({ effort: 'low', processStartedAt: at - 1000, effortSetAt: at - 1 }), change), 'high');
  // 起動時刻が分からない場合は、ハブから変えた時刻だけで判断します
  assert.equal(effortToFollow(agent({ processStartedAt: null }), change), 'high');
  assert.equal(effortToFollow(agent(), null), undefined);
});
