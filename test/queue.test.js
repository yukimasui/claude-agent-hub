// lib/queue.js のテストです。送信ガード、キュー操作の受け付け、判断待ちの提案の判定を確かめます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_QUEUE, applyQueueOp, hasOpenProposals, sendBlockReason } from '../lib/queue.js';

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
  assert.deepEqual(paused, { fields: { queue, queuePaused: true, queueNote: '手動で一時停止中' }, sendNext: false });

  const resumed = applyQueueOp(agent({ queue, queuePaused: true, queueNote: '判断待ちの提案があるため一時停止しました' }), { op: 'resume' });
  assert.deepEqual(resumed, { fields: { queue, queuePaused: false, queueNote: '' }, sendNext: false });
});

// ---------- 先頭の 1 件を送る ----------

test('先頭の送信は一時停止中でも受け付け、一時停止の状態は変えない', () => {
  const queue = [item('x1'), item('x2')];
  for (const state of ['idle', 'done']) {
    const r = applyQueueOp(agent({ state, queue, queuePaused: true, queueNote: '手動で一時停止中' }), { op: 'sendNext' });
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

test('判定は ```proposals の有無だけを見て、ブロックの中身は解析しない', () => {
  // 画面側（public/triage.js の parseProposals）は項目が取れたときだけ提案として扱うため、ここでの判定とは一致しない場合があります
  assert.equal(hasOpenProposals([{ role: 'assistant', text: '```proposals\n```' }]), true);
});
