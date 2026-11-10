// lib/transcript.js のテストです。Claude Code の transcript JSONL を会話表示用に整形する処理を確かめます。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectImageType, readTranscript, readTranscriptImage } from '../lib/transcript.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-transcript-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let seq = 0;
/** 行の配列を transcript ファイルに書いて読み込みます（キャッシュが効かないよう毎回別ファイルにします） */
function read(lines, limit) {
  return readTranscript(write(lines), limit);
}
/** 行の配列を新しい transcript ファイルに書き、そのパスを返します */
function write(lines) {
  const file = path.join(dir, `t${++seq}.jsonl`);
  fs.writeFileSync(file, toJsonl(lines));
  return file;
}
const toJsonl = (lines) => lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';

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

// ---------- 処理中に送った発言 ----------

// 処理中に送られ、ターンの途中で取り込まれた発言の記録です（Claude Code 2.1.322 で確認した形式）。
// 行は取り込まれた時点（ツールの結果の後）に書かれますが、timestamp は送信した時刻です。
const queuedCommand = (prompt, timestamp, extra = {}) => ({
  type: 'attachment',
  uuid: `att-${timestamp}`,
  timestamp,
  isSidechain: false,
  attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true, timestamp, source_uuid: 'src', ...extra },
});
const queueOp = (operation, content, timestamp, extra = {}) => ({ type: 'queue-operation', operation, content, timestamp, ...extra });
const at = (sec) => `2026-11-11T00:00:${String(sec).padStart(2, '0')}.000Z`;
const withTs = (line, timestamp) => ({ ...line, timestamp });

test('処理中に送って途中で取り込まれた発言を、利用者の発言として表示する', () => {
  const items = read([
    withTs(user('最初の依頼'), at(0)),
    withTs(assistant([toolUse('b1', 'Bash', { command: 'sleep 20' })]), at(1)),
    queueOp('enqueue', '<pasted_content id="1">\n方針を変えてください\n</pasted_content>', at(5)),
    withTs(user([toolResult('b1', 'done')]), at(21)),
    queueOp('remove', '<pasted_content id="1">\n方針を変えてください\n</pasted_content>', at(21), { reason: 'absorbed_mid_turn', commandUuid: 'src' }),
    queuedCommand('<pasted_content id="1">\n方針を変えてください\n</pasted_content>', at(5)),
    withTs(assistant([{ type: 'text', text: '了解しました' }]), at(22)),
  ]);
  assert.deepEqual(
    items.map((i) => [i.role, i.text ?? i.summary, i.queued]),
    [
      ['user', '最初の依頼', undefined],
      ['tool', 'sleep 20', undefined],
      ['user', '方針を変えてください', true],
      ['assistant', '了解しました', undefined],
    ],
  );
  assert.equal(items[2].ts, at(5));
});

test('取り込まれた発言は、送信した時刻より後に書かれた項目の前に並べる', () => {
  // 応答の生成中に送った場合、送信より後に書かれた応答やツール呼び出しの後で取り込まれるため、送信時刻の位置に戻します
  const items = read([
    withTs(user('依頼'), at(0)),
    withTs(assistant([{ type: 'text', text: '調べます' }]), at(2)),
    withTs(assistant([toolUse('b1', 'Bash', { command: 'ls' })]), at(4)),
    withTs(user([toolResult('b1', 'ok')]), at(5)),
    queuedCommand('やはり別の方法で', at(3)),
    withTs(assistant([{ type: 'text', text: '別の方法にします' }]), at(6)),
  ]);
  assert.deepEqual(
    items.map((i) => [i.role, i.text ?? i.summary]),
    [
      ['user', '依頼'],
      ['assistant', '調べます'],
      ['user', 'やはり別の方法で'],
      ['tool', 'ls'],
      ['assistant', '別の方法にします'],
    ],
  );
});

test('取り込まれずにターンの後で送られた発言は、通常の発言として 1 回だけ表示する', () => {
  // この場合は queued_command の行がなく、dequeue の後に通常の user 行として記録されます
  const items = read([
    withTs(user('依頼'), at(0)),
    queueOp('enqueue', '追加の指示', at(1)),
    withTs(assistant([{ type: 'text', text: '完了しました' }]), at(2)),
    queueOp('dequeue', undefined, at(3)),
    withTs(user('追加の指示', { origin: { kind: 'human' } }), at(3)),
  ]);
  assert.deepEqual(
    items.map((i) => [i.role, i.text, i.queued]),
    [
      ['user', '依頼', undefined],
      ['assistant', '完了しました', undefined],
      ['user', '追加の指示', undefined],
    ],
  );
});

test('利用者以外が起点の queued_command は利用者の発言として表示しない', () => {
  const items = read([
    // バックグラウンドのタスクの完了通知
    queuedCommand('<task-notification>完了</task-notification>', at(1), { commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' }, humanTurn: undefined }),
    // サブエージェントからの報告
    queuedCommand('[Subagent hand-back] 報告', at(2), { origin: { kind: 'peer', from: 'a1' }, isMeta: true, humanTurn: undefined }),
    // サブエージェントの中での指揮役からの指示
    { ...queuedCommand('サブエージェントへの指示', at(3), { origin: { kind: 'coordinator' }, commandMode: undefined }), isSidechain: true },
    // 利用者の発言でも、サブエージェントの記録にあるもの
    { ...queuedCommand('サブエージェント側の記録', at(4)), isSidechain: true },
    // 本文が空のもの
    queuedCommand('  ', at(5)),
  ]);
  assert.deepEqual(items, []);
});

// ---------- 利用者の発言ではない user 行 ----------

// ターンの終了後に届いたバックグラウンドのタスクの完了通知です（Claude Code 2.1.304〜2.1.321 で確認した形式）。
// 通常の user 行として記録され、行の origin.kind で利用者の発言と区別できます
const notification = (summary, extra = {}) =>
  user(
    `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>/tmp/out</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`,
    { origin: { kind: 'task-notification' }, ...extra },
  );

test('ターンの後に届いたタスクの完了通知は、利用者の発言ではなくシステムの行として表示する', () => {
  const items = read([
    user('依頼'),
    notification('Agent "調査" finished'),
    notification('Background command "テスト" completed (exit code 0)'),
    // origin のない記録でも、本文が完了通知のタグで始まるものは完了通知として扱います
    notification('Monitor "ログ" stream ended', { origin: undefined }),
  ]);
  assert.deepEqual(
    items.map((i) => [i.role, i.text]),
    [
      ['user', '依頼'],
      ['system', '完了通知: Agent "調査" finished'],
      ['system', '完了通知: Background command "テスト" completed (exit code 0)'],
      ['system', '完了通知: Monitor "ログ" stream ended'],
    ],
  );
});

test('利用者が入力した発言は、完了通知のタグで始まっていても利用者の発言として表示する', () => {
  const text = '<task-notification> の形式について教えてください';
  const items = read([user(text, { origin: { kind: 'human' } })]);
  assert.deepEqual(items, [{ role: 'user', text, ts: 't' }]);
});

test('会話の圧縮で作られた要約は、利用者の発言ではなく圧縮の項目として表示する', () => {
  // 圧縮の要約は isCompactSummary 付きの user 行として記録されます（Claude Code 2.1.322 で確認した形式）
  const summary = 'This session is being continued from a previous conversation.\n\n要約の本文';
  const items = read([
    user('依頼'),
    user(summary, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user('続きの依頼'),
  ]);
  assert.deepEqual(items, [
    { role: 'user', text: '依頼', ts: 't' },
    { role: 'compact', text: summary, ts: 't' },
    { role: 'user', text: '続きの依頼', ts: 't' },
  ]);
});

// ---------- 画像 ----------

// 1x1 の PNG と、各形式の先頭部分です（形式の判定は先頭のバイト列だけを見るため、本体は省略しています）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8 ', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const image = (data, mediaType = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } });
const readFile = (dims = { originalWidth: 2, originalHeight: 1, displayWidth: 1, displayHeight: 1 }) => ({
  toolUseResult: { type: 'image', file: { base64: PNG.toString('base64'), type: 'image/png', originalSize: PNG.length, dimensions: dims } },
});
// Read で画像を読んだときの transcript の形です（Claude Code 2.1.321 で確認した形式）
const readImageLines = (id = 'toolu_01', data = PNG, mediaType = 'image/png') => [
  assistant([toolUse(id, 'Read', { file_path: '/tmp/shot.png' })]),
  user([toolResult(id, [image(data, mediaType)])], readFile()),
];

test('Read で読んだ画像は、base64 を含めずに参照だけをツール呼び出しの項目に付ける', () => {
  const items = read(readImageLines());
  assert.deepEqual(items, [
    { role: 'tool', id: 'toolu_01', name: 'Read', summary: '/tmp/shot.png', ts: 't', images: [{ ref: 'toolu_01.0', mime: 'image/png', width: 1, height: 1 }] },
  ]);
  // 会話 API の応答になる項目に、画像の base64 が含まれないことを確かめます
  assert.ok(!JSON.stringify(items).includes(PNG.toString('base64')));
});

test('1 つのツール結果に画像が複数ある場合は、どの画像のものか分からない寸法を付けない', () => {
  // toolUseResult の寸法は 1 枚の画像についての情報なので、複数の画像に同じ寸法を付けると 2 枚目以降が誤った寸法になります
  const items = read([
    assistant([toolUse('toolu_01', 'mcp__browser__screenshot', {})]),
    user([toolResult('toolu_01', [image(PNG), image(PNG)])], readFile()),
  ]);
  assert.deepEqual(items[0].images, [
    { ref: 'toolu_01.0', mime: 'image/png' },
    { ref: 'toolu_01.1', mime: 'image/png' },
  ]);
});

test('利用者が貼り付けた画像は、同じ行の本文の項目に付け、本文がなければ画像だけの項目にする', () => {
  // 貼り付けた画像は、本文（[Image #1] を含む）と同じ content 配列に入り、行の uuid で参照します（Claude Code 2.1.318 で確認した形式）
  const items = read([
    user([{ type: 'text', text: '[Image #1] これを見てください' }, image(PNG)], { uuid: 'u-1', imagePasteIds: [1] }),
    user([image(JPEG, 'image/jpeg'), image(GIF, 'image/gif')], { uuid: 'u-2' }),
  ]);
  assert.deepEqual(items, [
    { role: 'user', text: '[Image #1] これを見てください', ts: 't', images: [{ ref: 'u-1.0', mime: 'image/png' }] },
    { role: 'user', text: '', ts: 't', images: [{ ref: 'u-2.0', mime: 'image/jpeg' }, { ref: 'u-2.1', mime: 'image/gif' }] },
  ]);
});

test('対応しない形式の画像や参照を作れない画像は、会話の項目に載せない', () => {
  const items = read([
    user([{ type: 'text', text: 'SVG と URL 参照' }, image(SVG, 'image/svg+xml'), { type: 'image', source: { type: 'url', url: 'http://example.com/a.png' } }], { uuid: 'u-1' }),
    user([{ type: 'text', text: 'uuid のない行' }, image(PNG)]),
    user([{ type: 'text', text: 'パスに使えない uuid' }, image(PNG)], { uuid: '../x' }),
    user([image(PNG)], { uuid: 'side', isSidechain: true }),
  ]);
  assert.deepEqual(items, [
    { role: 'user', text: 'SVG と URL 参照', ts: 't' },
    { role: 'user', text: 'uuid のない行', ts: 't' },
    { role: 'user', text: 'パスに使えない uuid', ts: 't' },
  ]);
});

test('readTranscriptImage は参照が指す画像を、中身から判定した形式で返す', () => {
  const file = write([
    ...readImageLines('toolu_01'),
    ...readImageLines('toolu_02', WEBP, 'image/webp'),
    // 宣言が JPEG でも中身が PNG なら、Content-Type には中身の形式を使います
    user([image(PNG, 'image/jpeg')], { uuid: 'u-1' }),
  ]);
  readTranscript(file);
  assert.deepEqual(readTranscriptImage(file, 'toolu_01.0'), { mime: 'image/png', data: PNG });
  assert.deepEqual(readTranscriptImage(file, 'toolu_02.0'), { mime: 'image/webp', data: WEBP });
  assert.deepEqual(readTranscriptImage(file, 'u-1.0'), { mime: 'image/png', data: PNG });
});

test('readTranscriptImage は対応しない形式や偽装した画像を返さない', () => {
  const file = write([
    // 宣言は PNG だが中身は SVG（スクリプトを含む）
    ...readImageLines('toolu_svg', SVG, 'image/png'),
    // 宣言が SVG のもの
    user([image(SVG, 'image/svg+xml')], { uuid: 'u-svg' }),
    // 中身が PNG でも宣言が対応外のもの
    user([image(PNG, 'image/bmp')], { uuid: 'u-bmp' }),
  ]);
  assert.deepEqual(readTranscript(file)[0].images, [{ ref: 'toolu_svg.0', mime: 'image/png', width: 1, height: 1 }]);
  assert.equal(readTranscriptImage(file, 'toolu_svg.0'), null);
  assert.equal(readTranscriptImage(file, 'u-svg.0'), null);
  assert.equal(readTranscriptImage(file, 'u-bmp.0'), null);
});

test('readTranscriptImage はその transcript にない参照やファイルのパスを受け付けない', () => {
  const mine = write(readImageLines('toolu_mine'));
  const other = write(readImageLines('toolu_other'));
  readTranscript(mine);
  readTranscript(other);
  assert.ok(readTranscriptImage(mine, 'toolu_mine.0'));
  // 別のエージェントの transcript にある参照は、自分の transcript からは引けません
  assert.equal(readTranscriptImage(mine, 'toolu_other.0'), null);
  for (const ref of ['toolu_mine.1', 'toolu_mine', '../' + path.basename(other), other, '', null]) assert.equal(readTranscriptImage(mine, ref), null);
  assert.equal(readTranscriptImage(null, 'toolu_mine.0'), null);
  assert.equal(readTranscriptImage(path.join(dir, 'missing.jsonl'), 'toolu_mine.0'), null);
});

test('readTranscriptImage は会話の読み込み前でも、追記された画像でも参照できる', () => {
  const file = write(readImageLines('toolu_01'));
  // 会話を読み込む前に画像だけを要求された場合も、transcript を読んで参照を作ります
  assert.deepEqual(readTranscriptImage(file, 'toolu_01.0')?.mime, 'image/png');
  // 追記された画像は、参照が見つからないときに読み直して見つけます
  fs.appendFileSync(file, toJsonl([user([{ type: 'text', text: '日本語の本文' }, image(GIF, 'image/gif')], { uuid: 'u-new' })]));
  assert.deepEqual(readTranscriptImage(file, 'u-new.0'), { mime: 'image/gif', data: GIF });
  // 以前の参照は、記録した位置のまま読めます
  assert.deepEqual(readTranscriptImage(file, 'toolu_01.0'), { mime: 'image/png', data: PNG });
});

test('readTranscriptImage は transcript が書き換わって記録した位置の内容が変わった場合、読み直して正しい画像を返す', () => {
  const file = write([user('前置き'), user([image(PNG)], { uuid: 'u-1' })]);
  readTranscript(file);
  // 前置きの長さを変えて同じ参照の画像を後ろにずらし、別の画像を同じ位置に置きます
  fs.writeFileSync(file, toJsonl([user([image(GIF, 'image/gif')], { uuid: 'u-2' }), user('前置き'), user([image(JPEG, 'image/jpeg')], { uuid: 'u-1' })]));
  assert.deepEqual(readTranscriptImage(file, 'u-1.0'), { mime: 'image/jpeg', data: JPEG });
});

test('detectImageType は先頭のバイト列から対応する形式だけを判定する', () => {
  assert.equal(detectImageType(PNG), 'image/png');
  assert.equal(detectImageType(JPEG), 'image/jpeg');
  assert.equal(detectImageType(GIF), 'image/gif');
  assert.equal(detectImageType(WEBP), 'image/webp');
  assert.equal(detectImageType(SVG), null);
  assert.equal(detectImageType(Buffer.from('<html>')), null);
  assert.equal(detectImageType(Buffer.alloc(0)), null);
});

test('sidechain を指定すると、サブエージェントの transcript（isSidechain の行）だけを読む', () => {
  const side = (o) => ({ ...o, isSidechain: true });
  const file = write([user('親の発言'), side(user('サブエージェントへの依頼')), side(assistant([{ type: 'text', text: '報告' }]))]);
  assert.deepEqual(readTranscript(file).map((i) => i.text), ['親の発言']);
  assert.deepEqual(readTranscript(file, 300, { sidechain: true }).map((i) => i.text), ['サブエージェントへの依頼', '報告']);
  // 読み方ごとに別のキャッシュを使うので、続けて通常の読み方をしても結果が混ざりません
  assert.deepEqual(readTranscript(file).map((i) => i.text), ['親の発言']);
});
