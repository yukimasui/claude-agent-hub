// lib/queue.js のテストです。送信ガード、キュー操作の受け付け、判断待ちの提案の判定を確かめます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_PAUSE_NOTE, INTERRUPT_PAUSE_NOTE, MANUAL_PAUSE_NOTE, MAX_QUEUE, PROPOSAL_PAUSE_NOTE,
  applyQueueOp, hasOpenProposals, sendBlockReason, shouldPauseForProposals,
} from '../lib/queue.js';

/** 送信してよい状態のエージェントを基本に、指定したフィールドだけを変えたものを作ります */
const agent = (fields = {}) => ({ alive: true, pending: [], state: 'idle', queue: [], queuePaused: false, queueNote: '', ...fields });
const item = (id, text = `task ${id}`, extra = {}) => ({ id, text, clearFirst: false, createdAt: 1, ...extra });

/** 指定した status（と code）の Error が投げられることを確かめます */
const assertHttpError = (fn, status, pattern, code) =>
  assert.throws(fn, (e) => {
    assert.equal(e.status, status);
    if (pattern) assert.match(e.message, pattern);
    assert.equal(e.code, code);
    return true;
  });

// ---------- 送信ガード ----------

test('送信ガードは誤入力になる状態ごとに理由を返す', () => {
  assert.match(sendBlockReason(agent({ alive: false })), /停止しています/);
  assert.match(sendBlockReason(agent({ pending: [{ reqId: 'r1' }] })), /回答待ちのダイアログ/);
  assert.match(sendBlockReason(agent({ state: 'waiting' })), /ターミナルでダイアログが表示されています/);
  assert.match(sendBlockReason(agent({ state: 'starting' })), /起動中です/);
});

test('送信ガードは停止 → 回答待ち → ターミナルのダイアログの順に理由を選ぶ', () => {
  assert.match(sendBlockReason(agent({ alive: false, pending: [{ reqId: 'r1' }], state: 'waiting' })), /停止しています/);
  assert.match(sendBlockReason(agent({ pending: [{ reqId: 'r1' }], state: 'waiting' })), /回答待ちのダイアログ/);
});

test('送信ガードは入力を受け付けられる状態では null を返す', () => {
  for (const state of ['idle', 'done', 'running', 'compacting']) assert.equal(sendBlockReason(agent({ state })), null, state);
});

// ---------- キューの追加 ----------

test('追加は末尾に入り、front を指定すると先頭に入る', () => {
  const a = agent({ queue: [item('x1')] });
  const r = applyQueueOp(a, { op: 'add', text: '  次の作業  ', clearFirst: 1 });
  assert.equal(r.sendNext, false);
  assert.deepEqual(r.fields.queue.map((x) => x.text), ['task x1', '次の作業']);
  const added = r.fields.queue[1];
  assert.match(added.id, /^[0-9a-f]{8}$/);
  assert.equal(added.clearFirst, true);
  assert.equal(typeof added.createdAt, 'number');
  // 元のキューは書き換えません（Store への反映は呼び出し側が行うため）
  assert.equal(a.queue.length, 1);

  const front = applyQueueOp(a, { op: 'add', text: '急ぎ', front: true });
  assert.deepEqual(front.fields.queue.map((x) => x.text), ['急ぎ', 'task x1']);
  assert.equal(front.fields.queue[0].clearFirst, false);
});

test('追加する内容が空、またはキューが上限に達している場合は 400 を返す', () => {
  assertHttpError(() => applyQueueOp(agent(), { op: 'add', text: '   ' }), 400, /内容が空/);
  assertHttpError(() => applyQueueOp(agent(), { op: 'add' }), 400, /内容が空/);
  const full = agent({ queue: Array.from({ length: MAX_QUEUE }, (_, i) => item(`q${i}`)) });
  assertHttpError(() => applyQueueOp(full, { op: 'add', text: 'もう 1 件' }), 400, new RegExp(`${MAX_QUEUE} 件まで`));
  const almost = agent({ queue: full.queue.slice(1) });
  assert.equal(applyQueueOp(almost, { op: 'add', text: '最後の 1 件' }).fields.queue.length, MAX_QUEUE);
});

// ---------- キューの更新・削除 ----------

test('更新は指定したフィールドだけを変え、元の項目は書き換えない', () => {
  const original = item('x1', '元の内容');
  const a = agent({ queue: [original, item('x2')] });

  let r = applyQueueOp(a, { op: 'update', itemId: 'x1', text: '  新しい内容 ' });
  assert.deepEqual(r.fields.queue[0], { ...original, text: '新しい内容' });
  assert.equal(r.sendNext, false);

  r = applyQueueOp(a, { op: 'update', itemId: 'x1', clearFirst: true });
  assert.deepEqual(r.fields.queue[0], { ...original, clearFirst: true });

  assert.deepEqual(a.queue[0], item('x1', '元の内容'));
});

test('更新で内容を空にする、または存在しない項目を指定するとエラーになる', () => {
  const a = agent({ queue: [item('x1')] });
  assertHttpError(() => applyQueueOp(a, { op: 'update', itemId: 'x1', text: ' ' }), 400, /内容が空/);
  assertHttpError(() => applyQueueOp(a, { op: 'update', itemId: 'nope', text: 'x' }), 404, /見つかりません/);
});

test('削除は指定した項目だけを取り除き、存在しない項目は 404 を返す', () => {
  const a = agent({ queue: [item('x1'), item('x2'), item('x3')] });
  const r = applyQueueOp(a, { op: 'remove', itemId: 'x2' });
  assert.deepEqual(r.fields.queue.map((x) => x.id), ['x1', 'x3']);
  assert.equal(a.queue.length, 3);
  assertHttpError(() => applyQueueOp(a, { op: 'remove', itemId: 'nope' }), 404, /見つかりません/);
});

// ---------- 並べ替え ----------

test('並べ替えは指定した順にし、指定にない項目は元の順で末尾に残す', () => {
  const a = agent({ queue: [item('x1'), item('x2'), item('x3'), item('x4')] });
  let r = applyQueueOp(a, { op: 'reorder', ids: ['x3', 'x1', 'x2', 'x4'] });
  assert.deepEqual(r.fields.queue.map((x) => x.id), ['x3', 'x1', 'x2', 'x4']);

  // 画面の表示が古く、存在しない ID や抜けがあっても項目は失われません
  r = applyQueueOp(a, { op: 'reorder', ids: ['x4', 'gone', 'x2'] });
  assert.deepEqual(r.fields.queue.map((x) => x.id), ['x4', 'x2', 'x1', 'x3']);

  r = applyQueueOp(a, { op: 'reorder', ids: 'x4' });
  assert.deepEqual(r.fields.queue.map((x) => x.id), ['x1', 'x2', 'x3', 'x4']);
  assert.deepEqual(a.queue.map((x) => x.id), ['x1', 'x2', 'x3', 'x4']);
});

// ---------- 一時停止・再開 ----------

test('一時停止と再開はキューを変えずに一時停止の状態とメモを切り替える', () => {
  const queue = [item('x1')];
  const paused = applyQueueOp(agent({ queue }), { op: 'pause' });
  assert.deepEqual(paused, { fields: { queue, queuePaused: true, queueNote: MANUAL_PAUSE_NOTE }, sendNext: false });

  const resumed = applyQueueOp(agent({ queue, queuePaused: true, queueNote: PROPOSAL_PAUSE_NOTE }), { op: 'resume' });
  assert.deepEqual(resumed, { fields: { queue, queuePaused: false, queueNote: '' }, sendNext: false });
});

// ---------- 先頭の 1 件を送る ----------

test('先頭の送信は一時停止中でも受け付け、一時停止の状態は変えない', () => {
  const queue = [item('x1'), item('x2')];
  for (const state of ['idle', 'done']) {
    const r = applyQueueOp(agent({ state, queue, queuePaused: true, queueNote: MANUAL_PAUSE_NOTE }), { op: 'sendNext' });
    assert.deepEqual(r, { fields: { queue }, sendNext: true }, state);
  }
});

test('先頭の送信はキューが空なら 400、送信ガードに当たれば code: blocked 付きの 409 を返す', () => {
  const queue = [item('x1')];
  assertHttpError(() => applyQueueOp(agent(), { op: 'sendNext' }), 400, /キューが空/);
  assertHttpError(() => applyQueueOp(agent({ queue, alive: false }), { op: 'sendNext' }), 409, /停止しています/, 'blocked');
  assertHttpError(() => applyQueueOp(agent({ queue, pending: [{ reqId: 'r1' }] }), { op: 'sendNext' }), 409, /回答待ちのダイアログ/, 'blocked');
  assertHttpError(() => applyQueueOp(agent({ queue, state: 'waiting' }), { op: 'sendNext' }), 409, /ターミナルでダイアログ/, 'blocked');
  assertHttpError(() => applyQueueOp(agent({ queue, state: 'starting' }), { op: 'sendNext' }), 409, /起動中です/, 'blocked');
});

test('先頭の送信は作業中なら code なしの 409 を返す（完了後に自動で送られるため）', () => {
  const queue = [item('x1')];
  for (const state of ['running', 'compacting']) {
    assertHttpError(() => applyQueueOp(agent({ queue, state }), { op: 'sendNext' }), 409, /作業中/, undefined);
  }
});

test('不明な操作は 400 を返す', () => {
  assertHttpError(() => applyQueueOp(agent(), { op: 'shuffle' }), 400, /不明な操作です: shuffle/);
  assertHttpError(() => applyQueueOp(agent(), {}), 400, /不明な操作です/);
});

// ---------- 判断待ちの提案 ----------

const proposals = '確認してください。\n```proposals\n{"items":[{"title":"A 案"}]}\n```';

test('最後の利用者の発言より後に proposals ブロックがあれば判断待ちとみなす', () => {
  assert.equal(hasOpenProposals([{ role: 'user', text: '調べて' }, { role: 'assistant', text: proposals }]), true);
  // 提案の後にツールの実行やシステム行が続いても、利用者が返答するまでは判断待ちのままです
  assert.equal(
    hasOpenProposals([
      { role: 'user', text: '調べて' },
      { role: 'assistant', text: proposals },
      { role: 'tool', name: 'Read' },
      { role: 'system', text: '中断されました' },
      { role: 'assistant', text: '補足です。' },
    ]),
    true,
  );
});

test('利用者が返答した後の提案や、proposals ブロックのない応答は判断待ちとみなさない', () => {
  assert.equal(hasOpenProposals([{ role: 'assistant', text: proposals }, { role: 'user', text: 'A 案で' }]), false);
  assert.equal(hasOpenProposals([{ role: 'user', text: '調べて' }, { role: 'assistant', text: '1. A 案\n2. B 案' }]), false);
  assert.equal(hasOpenProposals([]), false);
});

test('仕分けボードに出せる項目が無いブロックは判断待ちとみなさない', () => {
  // 画面（public/triage.js の parseProposals）と同じ基準で判定し、ボードが出ないのにキューだけが止まることを防ぎます
  const open = (text) => hasOpenProposals([{ role: 'user', text: '調べて' }, { role: 'assistant', text }]);
  assert.equal(open('```proposals\n```'), false);
  assert.equal(open('```proposals\n{"items":[]}\n```'), false);
  assert.equal(open('```proposals\n{"items":[{"title":""}]}\n```'), false);
  // 閉じの無いブロックは、画面でも提案として扱いません
  assert.equal(open('```proposals\n{"items":[{"title":"A 案"}]}'), false);
});

test('項目を取り出せない応答の前に提案があれば、その提案を判断待ちとみなす', () => {
  // 画面の自動表示（最後の利用者の発言より後の応答を新しい順に見る）と同じく、取り出せる最初の応答を探します
  assert.equal(
    hasOpenProposals([
      { role: 'user', text: '調べて' },
      { role: 'assistant', text: proposals },
      { role: 'assistant', text: '```proposals\n{"items":[]}\n```' },
    ]),
    true,
  );
});

test('1 つの応答で壊れたブロックの後に正しいブロックがあれば判断待ちとみなす', () => {
  const text = '```proposals\n{"items":[]}\n```\n訂正します。\n```proposals\n{"items":[{"title":"A 案"}]}\n```';
  assert.equal(hasOpenProposals([{ role: 'user', text: '調べて' }, { role: 'assistant', text }]), true);
});

// ---------- 提案への判断をキューに入れる場合 ----------

const openItems = [{ role: 'user', text: '調べて' }, { role: 'assistant', text: proposals }];

test('提案への判断は、ほかの項目より先に入る', () => {
  const r = applyQueueOp(agent({ queue: [item('x1'), item('x2')] }), { op: 'add', text: 'A 案を採用します', reply: true });
  assert.deepEqual(r.fields.queue.map((x) => x.text), ['A 案を採用します', 'task x1', 'task x2']);
  assert.equal(r.fields.queue[0].reply, true);
  // 通常の追加には判断の印を付けません
  const plain = applyQueueOp(agent(), { op: 'add', text: '次の作業' });
  assert.equal(plain.fields.queue[0].reply, undefined);
});

test('提案のために一時停止していれば、判断を入れたときに一時停止を解除する', () => {
  const a = agent({ queue: [item('x1')], queuePaused: true, queueNote: PROPOSAL_PAUSE_NOTE });
  const r = applyQueueOp(a, { op: 'add', text: 'A 案を採用します', reply: true });
  assert.equal(r.fields.queuePaused, false);
  assert.equal(r.fields.queueNote, '');
  assert.equal(r.sendNext, false);
  // 解除した後の自動送信では、先頭の判断を提案があっても止めずに送ります
  assert.equal(shouldPauseForProposals({ ...a, ...r.fields }, openItems), false);
});

test('提案以外の理由の一時停止は、判断を入れても解除しない', () => {
  // 手動の一時停止や中断による一時停止は利用者の意図なので、1 回の「再開」で判断から送られる状態にとどめます。
  // エラーによる一時停止も、原因を確かめてから再開できるよう残します
  for (const queueNote of [MANUAL_PAUSE_NOTE, INTERRUPT_PAUSE_NOTE, ERROR_PAUSE_NOTE]) {
    const r = applyQueueOp(agent({ queue: [item('x1')], queuePaused: true, queueNote }), { op: 'add', text: '判断', reply: true });
    assert.equal('queuePaused' in r.fields, false, queueNote);
    assert.equal(r.fields.queue[0].text, '判断', queueNote);
  }
  // 通常の追加では、提案による一時停止も解除しません（提案への返答にはならないため）
  const plain = applyQueueOp(agent({ queuePaused: true, queueNote: PROPOSAL_PAUSE_NOTE }), { op: 'add', text: '次の作業' });
  assert.equal('queuePaused' in plain.fields, false);
});

test('一時停止の理由の文言はそれぞれ異なる', () => {
  // 理由は queueNote の文言で見分けるため、文言が重なると提案による一時停止と誤って判別されます
  const notes = [PROPOSAL_PAUSE_NOTE, MANUAL_PAUSE_NOTE, INTERRUPT_PAUSE_NOTE, ERROR_PAUSE_NOTE];
  assert.equal(new Set(notes).size, notes.length);
  for (const note of notes) assert.ok(note, '空の文言は理由なしと区別できないため');
});

test('判断待ちの提案があっても、先頭が判断なら一時停止しない', () => {
  assert.equal(shouldPauseForProposals(agent({ queue: [item('r1', '判断', { reply: true }), item('x1')] }), openItems), false);
  // 先頭が判断以外なら、提案への返答より先に無関係な指示が届かないよう一時停止します
  assert.equal(shouldPauseForProposals(agent({ queue: [item('x1'), item('r1', '判断', { reply: true })] }), openItems), true);
  assert.equal(shouldPauseForProposals(agent({ queue: [item('x1')] }), openItems), true);
});

test('判断を送った後は、続く項目のために再び一時停止しない', () => {
  // 判断の送信で利用者の発言が提案の後に続くため、提案は返答済みになります
  const answered = [...openItems, { role: 'user', text: 'A 案を採用します' }, { role: 'assistant', text: '実施しました。' }];
  assert.equal(shouldPauseForProposals(agent({ queue: [item('x1')] }), answered), false);
});
