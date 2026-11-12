// lib/launch.js のテストです。エフォートの検証と、claude の起動コマンドの組み立てを、tmux や claude を起動せずに確かめます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildCommand, effortOption, requestedEffort, shq } from '../lib/launch.js';
import { EFFORT_LEVELS } from '../public/effort.js';

const opts = { bin: '/usr/bin/claude', settingsFile: '/hub/hooks.json', systemPrompt: 'ハブの説明' };
const agent = (fields = {}) => ({ model: 'haiku', permissionMode: '', effort: '', sessionId: 'sid-1', ...fields });

/** シェルが組み立てたコマンドをどう引数に分けるかを、実際に sh で確かめます（printf で 1 行に 1 つずつ出します） */
const shellWords = (command) => execFileSync('sh', ['-c', `printf '%s\\n' ${command}`], { encoding: 'utf8' }).split('\n').slice(0, -1);

test('作成フォームのエフォートは、許可リストの値と空文字だけをそのまま使い、それ以外は空文字にする', () => {
  for (const v of [...EFFORT_LEVELS, '']) assert.equal(effortOption(v), v);
  for (const v of [undefined, null, 'auto', 'High', ' high', 'high; rm -rf /', 3, ['high']]) assert.equal(effortOption(v), '', String(v));
});

test('エフォートの変更の要求は、許可リストの値と空文字（ユーザー設定に従う）を受け付け、それ以外は 400 にする', () => {
  for (const v of [...EFFORT_LEVELS, '']) assert.equal(requestedEffort({ effort: v }), v);
  for (const v of ['auto', 'High', 'high ', 3, true, ['high']]) {
    assert.throws(() => requestedEffort({ effort: v }), (e) => e.status === 400 && /エフォートの値が不正です/.test(e.message), String(v));
  }
});

test('エフォートの変更の要求に effort がなければ、「ユーザー設定に従う」への変更とせずに 400 にする', () => {
  // キーのない要求（誤った呼び出しなど）で、動いているエージェントを起動し直さないためです
  for (const body of [{}, { efort: 'high' }, null, [], 'high']) {
    assert.throws(() => requestedEffort(body), (e) => e.status === 400 && /エフォートを指定してください/.test(e.message), JSON.stringify(body));
  }
});

test('起動コマンドには、エフォートを指定したときだけ --effort を付ける', () => {
  const withEffort = shellWords(buildCommand(agent({ effort: 'xhigh' }), opts));
  assert.deepEqual(withEffort.slice(withEffort.indexOf('--effort'), withEffort.indexOf('--effort') + 2), ['--effort', 'xhigh']);
  // 空文字（ユーザー設定に従う）や値がない場合は付けません
  assert.equal(shellWords(buildCommand(agent({ effort: '' }), opts)).includes('--effort'), false);
  assert.equal(shellWords(buildCommand(agent({ effort: undefined }), opts)).includes('--effort'), false);
});

test('起動コマンドは、新しいセッションでは --session-id、会話の引き継ぎでは --resume を使い、プロンプトを -- の後に渡す', () => {
  const a = agent({ permissionMode: 'plan', effort: 'low' });
  assert.deepEqual(shellWords(buildCommand(a, { ...opts, prompt: '-v で始まる指示' })), [
    '/usr/bin/claude', '--model', 'haiku', '--settings', '/hub/hooks.json', '--permission-mode', 'plan', '--effort', 'low',
    '--append-system-prompt', 'ハブの説明', '--session-id', 'sid-1', '--', '-v で始まる指示',
  ]);
  // 再起動では会話を引き継ぎます。プロンプトは渡しません
  assert.deepEqual(shellWords(buildCommand(a, { ...opts, resume: true })).slice(-2), ['--resume', 'sid-1']);
  // 権限モードが空文字（ユーザー設定に従う）なら --permission-mode を付けません
  assert.equal(shellWords(buildCommand(agent(), opts)).includes('--permission-mode'), false);
});

test('引数に空白や引用符があっても、シェルで 1 つの引数として渡る', () => {
  const tricky = `it's "quoted" $HOME \`id\` ; echo x`;
  assert.deepEqual(shellWords(shq(tricky)), [tricky]);
  const words = shellWords(buildCommand(agent(), { ...opts, systemPrompt: tricky, prompt: tricky }));
  assert.equal(words[words.indexOf('--append-system-prompt') + 1], tricky);
  assert.equal(words.at(-1), tricky);
});
