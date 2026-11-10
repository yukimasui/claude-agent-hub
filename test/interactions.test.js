// lib/interactions.js のテストです。ブラウザからの回答が hook の出力 JSON に正しく変換されることを確かめます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutput, describe, kindOf } from '../lib/interactions.js';

const perm = (decision) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });

const questionReq = {
  event: 'PermissionRequest',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      { header: '言語', question: '好きな言語は？', options: [{ label: 'TypeScript' }, { label: 'Python' }] },
      { header: 'ツール', question: '使うツールは？', multiSelect: true, options: [{ label: 'git' }, { label: 'tmux' }] },
    ],
  },
};
const planReq = { event: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: '# 計画\n1. 作る', planFilePath: '/tmp/plan.md' } };
const elicitReq = { event: 'Elicitation', mcp_server_name: 'profile' };

/** 400 エラー（入力の誤り）として投げられることを確かめます */
const assertBadRequest = (fn, pattern) =>
  assert.throws(fn, (e) => {
    assert.equal(e.status, 400);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });

test('kindOf と describe は要求の種類と一覧用の説明を返す', () => {
  assert.equal(kindOf(questionReq), 'question');
  assert.equal(describe(questionReq), '質問: 言語 ほか1件');
  assert.equal(kindOf(planReq), 'plan');
  assert.equal(describe(planReq), '計画の承認待ち');
  assert.equal(kindOf(elicitReq), 'elicitation');
  assert.equal(describe(elicitReq), '入力要求: profile');
  assert.equal(kindOf({ tool_name: 'Bash' }), 'permission');
  assert.equal(describe({ tool_name: 'Bash' }), '許可待ち: Bash');
});

test('「ターミナルで回答」は何も出力せず TUI に任せる', () => {
  for (const req of [questionReq, planReq, elicitReq, { tool_name: 'Bash' }]) {
    assert.deepEqual(buildOutput(req, { action: 'terminal' }), { result: 'terminal', output: null });
  }
});

test('質問への回答は answers と annotations を updatedInput に入れて許可する', () => {
  const out = buildOutput(questionReq, {
    action: 'answer',
    answers: { '好きな言語は？': ' Rust ', '使うツールは？': ['git', '', 'tmux'] },
    annotations: {
      '好きな言語は？': { notes: ' メモです ' },
      '使うツールは？': { notes: '  ', preview: '図' },
    },
  });
  assert.equal(out.result, 'answer');
  assert.deepEqual(
    out.output,
    perm({
      behavior: 'allow',
      updatedInput: {
        ...questionReq.tool_input,
        answers: { '好きな言語は？': 'Rust', '使うツールは？': 'git, tmux' },
        // 空のメモは送らない
        annotations: { '好きな言語は？': { notes: 'メモです' }, '使うツールは？': { preview: '図' } },
      },
    }),
  );
});

test('メモが無ければ annotations を付けない', () => {
  const out = buildOutput(questionReq, { action: 'answer', answers: { '好きな言語は？': 'Python', '使うツールは？': ['git'] } });
  assert.equal('annotations' in out.output.hookSpecificOutput.decision.updatedInput, false);
});

test('未回答の質問があれば 400 エラーにする', () => {
  assertBadRequest(() => buildOutput(questionReq, { action: 'answer', answers: { '好きな言語は？': 'Python', '使うツールは？': [] } }), /ツール/);
});

test('選択せずに返信すると、返信内容を拒否メッセージとして伝える', () => {
  const out = buildOutput(questionReq, { action: 'respond', text: ' 緑が好きです ' });
  assert.equal(out.result, 'respond');
  assert.deepEqual(out.output, perm({ behavior: 'deny', message: 'ユーザーは選択肢を選ばずに次のように返信しました:\n緑が好きです' }));
  assertBadRequest(() => buildOutput(questionReq, { action: 'respond', text: '  ' }));
});

test('拒否は既定のメッセージを補い、中断の指定を引き継ぐ', () => {
  assert.deepEqual(buildOutput({ tool_name: 'Bash' }, { action: 'deny' }).output, perm({ behavior: 'deny', message: 'ユーザーがブラウザから拒否しました。' }));
  assert.deepEqual(
    buildOutput(planReq, { action: 'deny', message: 'やめます', interrupt: true }).output,
    perm({ behavior: 'deny', message: 'やめます', interrupt: true }),
  );
});

test('計画の承認は updatedInput を添え、指定されたモードへの切り替えを含める', () => {
  const out = buildOutput(planReq, { action: 'approve', mode: 'acceptEdits' });
  assert.equal(out.result, 'approve');
  assert.deepEqual(
    out.output,
    perm({ behavior: 'allow', updatedInput: planReq.tool_input, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }),
  );
  // 想定外のモードは無視して、モードを変えずに承認する
  const plain = buildOutput(planReq, { action: 'approve', mode: 'bypassPermissions' });
  assert.deepEqual(plain.output, perm({ behavior: 'allow', updatedInput: planReq.tool_input }));
});

test('計画の修正依頼は内容が必須', () => {
  assert.deepEqual(buildOutput(planReq, { action: 'revise', message: '短く' }).output, perm({ behavior: 'deny', message: '短く' }));
  assertBadRequest(() => buildOutput(planReq, { action: 'revise', message: '' }));
});

test('権限の「許可して記憶」は選ばれた提案ルールだけを渡す', () => {
  const req = { tool_name: 'Bash', permission_suggestions: [{ type: 'addRules', rules: ['a'] }, { type: 'addRules', rules: ['b'] }] };
  assert.deepEqual(buildOutput(req, { action: 'allow' }).output, perm({ behavior: 'allow' }));
  assert.deepEqual(buildOutput(req, { action: 'allowAlways', suggestions: [1, 5] }).output, perm({ behavior: 'allow', updatedPermissions: [req.permission_suggestions[1]] }));
  // 指定が無ければすべての提案を採用する
  assert.deepEqual(buildOutput(req, { action: 'allowAlways' }).output, perm({ behavior: 'allow', updatedPermissions: req.permission_suggestions }));
  assert.deepEqual(buildOutput({ tool_name: 'Bash' }, { action: 'allowAlways' }).output, perm({ behavior: 'allow' }));
});

test('Elicitation は accept / decline / cancel を Elicitation 用の出力にする', () => {
  const el = (o) => ({ hookSpecificOutput: { hookEventName: 'Elicitation', ...o } });
  assert.deepEqual(buildOutput(elicitReq, { action: 'accept', content: { name: 'たま', age: 3 } }), {
    result: 'accept',
    output: el({ action: 'accept', content: { name: 'たま', age: 3 } }),
  });
  assert.deepEqual(buildOutput(elicitReq, { action: 'accept', content: 'x' }).output, el({ action: 'accept', content: {} }));
  assert.deepEqual(buildOutput(elicitReq, { action: 'decline' }).output, el({ action: 'decline' }));
  assert.deepEqual(buildOutput(elicitReq, { action: 'cancel' }).output, el({ action: 'cancel' }));
});

test('種類に合わない操作は 400 エラーにする', () => {
  assertBadRequest(() => buildOutput(elicitReq, { action: 'allow' }), /不明な操作/);
  assertBadRequest(() => buildOutput(questionReq, { action: 'approve' }), /不明な操作/);
  assertBadRequest(() => buildOutput(planReq, { action: 'answer' }), /不明な操作/);
  assertBadRequest(() => buildOutput({ tool_name: 'Bash' }, {}), /不明な操作/);
});
