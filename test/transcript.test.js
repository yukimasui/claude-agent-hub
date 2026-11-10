// lib/transcript.js のテストです。Claude Code の transcript JSONL を会話表示用に整形する処理を確かめます。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTranscript } from '../lib/transcript.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-transcript-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let seq = 0;
/** 行の配列を transcript ファイルに書いて読み込みます（キャッシュが効かないよう毎回別ファイルにします） */
function read(lines, limit) {
  const file = path.join(dir, `t${++seq}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return readTranscript(file, limit);
}

const user = (content, extra = {}) => ({ type: 'user', timestamp: 't', message: { role: 'user', content }, ...extra });
const assistant = (content) => ({ type: 'assistant', timestamp: 't', message: { role: 'assistant', content } });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, content, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });

test('ハブから送った長文の <pasted_content> タグを外して表示する', () => {
  const items = read([user('<pasted_content id="1">\n1 行目\n2 行目\n</pasted_content>')]);
  assert.deepEqual(items, [{ role: 'user', text: '1 行目\n2 行目', ts: 't' }]);
});

test('システム由来の入力は表示しないか、システム行として表示する', () => {
  const items = read([
    user('<system-reminder>内部の注意</system-reminder>'),
    user('メタ情報', { isMeta: true }),
    user('サブエージェントの入力', { isSidechain: true }),
    user('<command-name>/model</command-name>\n<command-args>haiku</command-args>'),
    user('<local-command-stdout>Set model to haiku</local-command-stdout>'),
    user('<local-command-stdout></local-command-stdout>'),
    user('<local-command-caveat>Caveat</local-command-caveat>'),
    user([{ type: 'text', text: '[Request interrupted by user]' }]),
    '壊れた行',
  ]);
  assert.deepEqual(
    items.map((i) => [i.role, i.text]),
    [
      ['system', '/model haiku'],
      ['system', 'Set model to haiku'],
      ['system', '中断されました'],
    ],
  );
});

test('AskUserQuestion の回答を toolUseResult から対応付ける', () => {
  const questions = [{ header: '言語', question: '好きな言語は？', options: [{ label: 'TS' }, { label: 'Py' }] }];
  const items = read([
    assistant([{ type: 'text', text: '質問します' }, toolUse('q1', 'AskUserQuestion', { questions })]),
    user([toolResult('q1', 'User has answered')], {
      toolUseResult: { answers: { '好きな言語は？': 'TS' }, annotations: { '好きな言語は？': { notes: 'メモ' } } },
    }),
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { role: 'assistant', text: '質問します', ts: 't' });
  const q = items[1];
  assert.equal(q.role, 'question');
  assert.equal(q.status, 'answered');
  assert.deepEqual(q.questions, questions);
  assert.deepEqual(q.answers, { '好きな言語は？': 'TS' });
  assert.deepEqual(q.annotations, { '好きな言語は？': { notes: 'メモ' } });
  assert.equal(q.resultText, undefined);
});

test('回答が構造化されていない質問は結果の本文を残し、拒否された質問は rejected にする', () => {
  const items = read([
    assistant([toolUse('q1', 'AskUserQuestion', { questions: [] }), toolUse('q2', 'AskUserQuestion', { questions: [] })]),
    user([toolResult('q1', [{ type: 'text', text: '回答: TS' }]), toolResult('q2', '緑が好きです', { is_error: true })]),
  ]);
  assert.deepEqual(
    items.map((i) => [i.status, i.answers, i.resultText]),
    [
      ['answered', null, '回答: TS'],
      ['rejected', null, '緑が好きです'],
    ],
  );
});

test('計画は承認・却下の状態と結果を表示する', () => {
  const items = read([
    assistant([toolUse('p1', 'ExitPlanMode', { plan: '# 計画 1' }), toolUse('p2', 'ExitPlanMode', { plan: '# 計画 2', planFilePath: '/tmp/p.md' })]),
    user([toolResult('p1', '1 ステップにしてください', { is_error: true }), toolResult('p2', 'User has approved')]),
  ]);
  assert.deepEqual(
    items.map((i) => [i.role, i.plan, i.planFilePath, i.status, i.resultText]),
    [
      ['plan', '# 計画 1', null, 'rejected', '1 ステップにしてください'],
      ['plan', '# 計画 2', '/tmp/p.md', 'approved', 'User has approved'],
    ],
  );
});

test('通常のツールは要約を表示し、失敗した場合はエラー内容を付ける', () => {
  const items = read([
    assistant([toolUse('b1', 'Bash', { command: 'ls   -la' }), toolUse('t1', 'TodoWrite', { todos: [{ content: 'a', status: 'pending' }] })]),
    user([toolResult('b1', 'command not found', { is_error: true }), toolResult('unknown', '対応する呼び出しがない失敗', { is_error: true })]),
  ]);
  assert.deepEqual(items[0], { role: 'tool', id: 'b1', name: 'Bash', summary: 'ls -la', ts: 't', error: 'command not found' });
  assert.deepEqual(items[1], { role: 'todos', id: 't1', todos: [{ content: 'a', status: 'pending' }], ts: 't' });
  assert.deepEqual(items[2], { role: 'tool_error', text: '対応する呼び出しがない失敗', ts: 't' });
});

test('limit で末尾の件数だけを返し、ファイルが無ければ空にする', () => {
  const items = read([user('1'), user('2'), user('3')], 2);
  assert.deepEqual(items.map((i) => i.text), ['2', '3']);
  assert.deepEqual(readTranscript(path.join(dir, 'missing.jsonl')), []);
  assert.deepEqual(readTranscript(null), []);
});
