// lib/queue.js のテストです。送信ガード、キュー操作の受け付け、判断待ちの提案の判定を確かめます。
// あわせて、キューの画面で判断の項目に付ける目印（public/queue.js の replyMark）が、サーバの判定とそろっていることを確かめます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_PAUSE_NOTE, INTERRUPT_PAUSE_NOTE, MANUAL_PAUSE_NOTE, MAX_QUEUE, PROPOSAL_PAUSE_NOTE,
  STALE_REPLY_ANSWERED_NOTE, STALE_REPLY_NEW_PROPOSAL_NOTE,
  applyQueueOp, hasOpenProposals, proposalPauseNote, sendBlockReason,
} from '../lib/queue.js';
import { proposalKey, findOpenProposals } from '../public/triage.js';
import { queueSignature, replyMark, sendNextTitle, staleHead } from '../public/queue.js';

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

test('補足にコードブロックを含む提案も判断待ちとみなす', () => {
  // 画面で仕分けボードが開く提案では、キューも一時停止します（判定の基準を画面とそろえるため）
  const detail = '例:\n```bash\nnpm test\n```';
  const text = '```proposals\n' + JSON.stringify({ items: [{ title: 'A 案', detail }] }) + '\n```';
  assert.equal(hasOpenProposals([{ role: 'user', text: '調べて' }, { role: 'assistant', text }]), true);
});

test('1 つの応答で壊れたブロックの後に正しいブロックがあれば判断待ちとみなす', () => {
  const text = '```proposals\n{"items":[]}\n```\n訂正します。\n```proposals\n{"items":[{"title":"A 案"}]}\n```';
  assert.equal(hasOpenProposals([{ role: 'user', text: '調べて' }, { role: 'assistant', text }]), true);
});

// ---------- 提案への判断をキューに入れる場合 ----------

const openItems = [{ role: 'user', text: '調べて', ts: 't1' }, { role: 'assistant', text: proposals, ts: 't2' }];
// openItems の提案への判断として、画面（public/app.js）がキューに入れる項目と同じ形の印です
const openKey = proposalKey(openItems[1]);

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
  // 画面（public/app.js）と同じく、対象の提案の識別子を付けて追加します
  const r = applyQueueOp(a, { op: 'add', text: 'A 案を採用します', reply: true, proposal: openKey });
  assert.equal(r.fields.queuePaused, false);
  assert.equal(r.fields.queueNote, '');
  assert.equal(r.sendNext, false);
  // 解除した後の自動送信では、先頭の判断が判断待ちの提案と一致するので、提案があっても止めずに送ります
  assert.equal(r.fields.queue[0].proposal, openKey);
  assert.equal(proposalPauseNote({ ...a, ...r.fields }, openItems), null);
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
  const notes = [PROPOSAL_PAUSE_NOTE, MANUAL_PAUSE_NOTE, INTERRUPT_PAUSE_NOTE, ERROR_PAUSE_NOTE, STALE_REPLY_NEW_PROPOSAL_NOTE, STALE_REPLY_ANSWERED_NOTE];
  assert.equal(new Set(notes).size, notes.length);
  for (const note of notes) assert.ok(note, '空の文言は理由なしと区別できないため');
});

test('判断待ちの提案があっても、先頭が判断なら一時停止しない', () => {
  assert.equal(proposalPauseNote(agent({ queue: [item('r1', '判断', { reply: true, proposal: openKey }), item('x1')] }), openItems), null);
  // 先頭が判断以外なら、提案への返答より先に無関係な指示が届かないよう一時停止します
  assert.equal(proposalPauseNote(agent({ queue: [item('x1'), item('r1', '判断', { reply: true, proposal: openKey })] }), openItems), PROPOSAL_PAUSE_NOTE);
  assert.equal(proposalPauseNote(agent({ queue: [item('x1')] }), openItems), PROPOSAL_PAUSE_NOTE);
});

test('判断を送った後は、続く項目のために再び一時停止しない', () => {
  // 判断の送信で利用者の発言が提案の後に続くため、提案は返答済みになります
  const answered = [...openItems, { role: 'user', text: 'A 案を採用します' }, { role: 'assistant', text: '実施しました。' }];
  assert.equal(proposalPauseNote(agent({ queue: [item('x1')] }), answered), null);
});

// ---------- 判断の対象の提案との照合 ----------

test('判断をキューに入れるときは、対象の提案の識別子を記録する', () => {
  const r = applyQueueOp(agent(), { op: 'add', text: '判断', reply: true, proposal: openKey });
  assert.equal(r.fields.queue[0].proposal, openKey);
  // 文字列でない値や長すぎる値は記録しません（照合しない判断として扱われます）
  for (const proposal of [123, '', 'x'.repeat(201), null]) {
    assert.equal('proposal' in applyQueueOp(agent(), { op: 'add', text: '判断', reply: true, proposal }).fields.queue[0], false, String(proposal));
  }
  // 判断以外の項目には、識別子が渡されても記録しません
  assert.equal('proposal' in applyQueueOp(agent(), { op: 'add', text: '次の作業', proposal: openKey }).fields.queue[0], false);
});

test('判断を入れた後に同じターンで新しい提案が出たら、古い判断を送らずに一時停止する', () => {
  const a = agent({ queue: [item('r1', '判断', { reply: true, proposal: openKey }), item('x1')] });
  const newer = { role: 'assistant', text: '```proposals\n{"items":[{"title":"C 案"}]}\n```', ts: 't3' };
  assert.equal(proposalPauseNote(a, [...openItems, newer]), STALE_REPLY_NEW_PROPOSAL_NOTE);
});

test('判断を入れた後に利用者の発言を挟んで新しい提案が出たら、古い判断を送らずに一時停止する', () => {
  const a = agent({ queue: [item('r1', '判断', { reply: true, proposal: openKey })] });
  const items = [...openItems, { role: 'user', text: '先に別の調査をして', ts: 't3' }, { role: 'assistant', text: proposals, ts: 't4' }];
  // 本文が同じ提案でも、別の応答なので古い判断の対象ではありません
  assert.equal(proposalPauseNote(a, items), STALE_REPLY_NEW_PROPOSAL_NOTE);
});

test('判断の対象の提案にすでに返答があれば、判断を重ねて送らずに一時停止する', () => {
  // ターミナルや入力欄から先に返答した場合です。判断を送ると同じ提案に二重に返答することになります
  const a = agent({ queue: [item('r1', '判断', { reply: true, proposal: openKey })] });
  const answered = [...openItems, { role: 'user', text: 'A 案で進めて', ts: 't3' }, { role: 'assistant', text: '進めました。', ts: 't4' }];
  assert.equal(proposalPauseNote(a, answered), STALE_REPLY_ANSWERED_NOTE);
});

test('対象の提案を記録していない判断は、照合せずに送る', () => {
  // 照合を始める前にキューに入っていた判断（agents.json から復元したもの）は、これまでどおり扱います
  const a = agent({ queue: [item('r1', '判断', { reply: true })] });
  const newer = { role: 'assistant', text: '```proposals\n{"items":[{"title":"C 案"}]}\n```', ts: 't3' };
  assert.equal(proposalPauseNote(a, [...openItems, newer]), null);
  assert.equal(proposalPauseNote(a, []), null);
});

test('古い判断による一時停止から単に再開しても、古い判断は送らずにその時点の理由で再び一時停止する', () => {
  // 後ろの項目を進めるつもりで「再開」を押しても、古い判断が意図せず送られないようにします
  const queue = [item('r1', '判断', { reply: true, proposal: openKey }), item('x1')];
  const newer = { role: 'assistant', text: '```proposals\n{"items":[{"title":"C 案"}]}\n```', ts: 't3' };
  // 返答済みとして止まった後に新しい提案が出た場合も、押した時点の状況に合わせた理由になります
  const a = agent({ queue, queuePaused: true, queueNote: STALE_REPLY_ANSWERED_NOTE });
  const r = applyQueueOp(a, { op: 'resume' });
  assert.equal(r.fields.queuePaused, false);
  assert.equal(r.fields.queueNote, '');
  assert.equal(r.fields.queue[0].proposal, openKey);
  const resumed = { ...a, ...r.fields };
  assert.equal(proposalPauseNote(resumed, [...openItems, { role: 'user', text: 'A 案で', ts: 't3' }, { ...newer, ts: 't4' }]), STALE_REPLY_NEW_PROPOSAL_NOTE);
  assert.equal(proposalPauseNote(resumed, [...openItems, { role: 'user', text: 'A 案で', ts: 't3' }]), STALE_REPLY_ANSWERED_NOTE);
  // 対象の提案が判断待ちに戻っていれば（ターミナルで巻き戻した場合など）、古くないので通常どおり送ります
  assert.equal(proposalPauseNote(resumed, openItems), null);
});

test('「古い判断を送って再開」では、指定した判断を照合せずに送れるようにする', () => {
  const queue = [item('r1', '判断', { reply: true, proposal: openKey }), item('x1')];
  const newer = { role: 'assistant', text: '```proposals\n{"items":[{"title":"C 案"}]}\n```', ts: 't3' };
  for (const queueNote of [STALE_REPLY_NEW_PROPOSAL_NOTE, STALE_REPLY_ANSWERED_NOTE, MANUAL_PAUSE_NOTE]) {
    const a = agent({ queue, queuePaused: true, queueNote });
    const r = applyQueueOp(a, { op: 'resume', staleReply: 'send', itemId: 'r1' });
    assert.equal(r.fields.queuePaused, false, queueNote);
    assert.equal(r.fields.queueNote, '', queueNote);
    assert.deepEqual(r.fields.queue[0], { id: 'r1', text: '判断', clearFirst: false, createdAt: 1, reply: true }, queueNote);
    assert.equal(r.fields.queue[1], queue[1], queueNote);
    assert.equal(proposalPauseNote({ ...a, ...r.fields }, [...openItems, newer]), null, queueNote);
    // 元のキューは書き換えません
    assert.equal(queue[0].proposal, openKey, queueNote);
  }
});

test('「古い判断を削除して再開」では、指定した判断を削除して続く項目から送る', () => {
  const queue = [item('r1', '判断', { reply: true, proposal: openKey }), item('x1')];
  const a = agent({ queue, queuePaused: true, queueNote: STALE_REPLY_ANSWERED_NOTE });
  const r = applyQueueOp(a, { op: 'resume', staleReply: 'drop', itemId: 'r1' });
  assert.equal(r.fields.queuePaused, false);
  assert.equal(r.fields.queueNote, '');
  assert.deepEqual(r.fields.queue.map((x) => x.id), ['x1']);
  assert.equal(queue.length, 2);
  const answered = [...openItems, { role: 'user', text: 'A 案で', ts: 't3' }];
  assert.equal(proposalPauseNote({ ...a, ...r.fields }, answered), null);
});

test('古い判断の扱いの指定は、提案への判断の項目だけを受け付ける', () => {
  const a = agent({ queue: [item('r1', '判断', { reply: true, proposal: openKey }), item('x1')], queuePaused: true, queueNote: STALE_REPLY_ANSWERED_NOTE });
  // 画面を開いた後に削除された項目や、判断ではない項目を誤って扱わないようにします
  assertHttpError(() => applyQueueOp(a, { op: 'resume', staleReply: 'drop', itemId: 'gone' }), 404, /見つかりません/);
  assertHttpError(() => applyQueueOp(a, { op: 'resume', staleReply: 'drop', itemId: 'x1' }), 400, /提案への判断ではない/);
  assertHttpError(() => applyQueueOp(a, { op: 'resume', staleReply: 'later', itemId: 'r1' }), 400, /不明な指定/);
});

test('古い判断による一時停止中に新しい判断を入れると、一時停止を解除して新しい判断から送る', () => {
  const newer = { role: 'assistant', text: '```proposals\n{"items":[{"title":"C 案"}]}\n```', ts: 't3' };
  const items = [...openItems, newer];
  const a = agent({ queue: [item('r1', '古い判断', { reply: true, proposal: openKey })], queuePaused: true, queueNote: STALE_REPLY_NEW_PROPOSAL_NOTE });
  const r = applyQueueOp(a, { op: 'add', text: '新しい判断', reply: true, proposal: proposalKey(newer) });
  assert.equal(r.fields.queuePaused, false);
  assert.equal(r.fields.queueNote, '');
  assert.deepEqual(r.fields.queue.map((x) => x.text), ['新しい判断', '古い判断']);
  assert.equal(proposalPauseNote({ ...a, ...r.fields }, items), null);
  // 新しい判断を送った後、古い判断は対象の提案に返答済みになるので、順番が来たときに改めて止まります
  const after = { ...a, ...r.fields, queue: r.fields.queue.slice(1) };
  assert.equal(proposalPauseNote(after, [...items, { role: 'user', text: '新しい判断', ts: 't4' }]), STALE_REPLY_ANSWERED_NOTE);
});

// ---------- キューの画面の目印（public/queue.js の replyMark） ----------

/** 画面（public/app.js）と同じく、会話の項目から判断待ちの提案の識別子を求めます */
const openKeyOf = (items) => {
  const open = findOpenProposals(items);
  return open ? proposalKey(open) : null;
};

test('キューの画面では、提案への判断の項目にだけ目印を付ける', () => {
  assert.equal(replyMark(item('x1'), openKey), null);
  const mark = replyMark(item('r1', '判断', { reply: true, proposal: openKey }), openKey);
  assert.equal(mark.stale, false);
  assert.equal(mark.label, '提案への判断');
  // 先頭から外すと一時停止することがある点を、ツールチップで伝えます
  assert.match(mark.title, /先頭にある間は/);
  assert.match(mark.title, /一時停止/);
});

test('キューの画面の「古い判断」の目印は、サーバが先頭の判断を送らずに止める判定と一致する', () => {
  const newer = { role: 'assistant', text: '```proposals\n{"items":[{"title":"C 案"}]}\n```', ts: 't3' };
  const cases = {
    判断待ち: openItems,
    新しい提案: [...openItems, newer],
    返答済み: [...openItems, { role: 'user', text: 'A 案で進めて', ts: 't3' }, { role: 'assistant', text: '進めました。', ts: 't4' }],
  };
  for (const [name, items] of Object.entries(cases)) {
    for (const head of [item('r1', '判断', { reply: true, proposal: openKey }), item('r1', '判断', { reply: true })]) {
      const note = proposalPauseNote(agent({ queue: [head] }), items);
      const mark = replyMark(head, openKeyOf(items));
      assert.equal(mark.stale, note === STALE_REPLY_NEW_PROPOSAL_NOTE || note === STALE_REPLY_ANSWERED_NOTE, `${name} ${head.proposal ?? '記録なし'}`);
    }
  }
  // 古くなった理由（新しい提案が出たのか、返答済みなのか）もツールチップで見分けられるようにします
  const head = item('r1', '判断', { reply: true, proposal: openKey });
  assert.match(replyMark(head, openKeyOf(cases.新しい提案)).title, /新しい提案が出ています/);
  assert.match(replyMark(head, openKeyOf(cases.返答済み)).title, /すでに返答があります/);
  assert.equal(replyMark(head, null).label, '古い判断');
});

test('判断待ちの提案がまだ分からないときは、判断を古いとみなさない', () => {
  // エージェントを切り替えた直後など、会話を読み込む前に誤って「古い判断」と表示しないためです
  const mark = replyMark(item('r1', '判断', { reply: true, proposal: openKey }), undefined);
  assert.equal(mark.stale, false);
});

test('先頭以外にある判断にも、対象の提案に応じた目印を付ける', () => {
  // 古い判断が後ろに残っている場合（新しい判断が前に入った場合など）も、並べ替えや削除の前に見分けられるようにします
  const newer = { role: 'assistant', text: '```proposals\n{"items":[{"title":"C 案"}]}\n```', ts: 't3' };
  const queue = [item('r2', '新しい判断', { reply: true, proposal: proposalKey(newer) }), item('r1', '古い判断', { reply: true, proposal: openKey })];
  const key = openKeyOf([...openItems, newer]);
  assert.deepEqual(queue.map((x) => replyMark(x, key).stale), [false, true]);
});

test('一時停止中のキューの先頭が古い判断のときだけ、古い判断の扱いを選ぶ再開ボタンを出す', () => {
  const newer = { role: 'assistant', text: '```proposals\n{"items":[{"title":"C 案"}]}\n```', ts: 't3' };
  const staleKey = openKeyOf([...openItems, newer]);
  const head = item('r1', '判断', { reply: true, proposal: openKey });
  const paused = agent({ queue: [head, item('x1')], queuePaused: true, queueNote: MANUAL_PAUSE_NOTE });
  // 手動の一時停止中でも、先頭が古い判断なら選んでもらいます（単なる再開では送る前の照合で再び止まるだけのため）
  assert.equal(staleHead(paused, staleKey), head);
  assert.equal(staleHead(paused, null), head);
  // 対象の提案がまだ判断待ちなら、通常の再開で送れます
  assert.equal(staleHead(paused, openKey), null);
  // 古いかどうか分からず、一時停止の理由も古い判断ではないときは通常の再開にし、サーバの照合に任せます
  assert.equal(staleHead(paused, undefined), null);
  // 一時停止していない、先頭が判断でない、対象の記録がない場合も通常どおりです
  assert.equal(staleHead({ ...paused, queuePaused: false }, staleKey), null);
  assert.equal(staleHead({ ...paused, queue: [item('x1'), head] }, staleKey), null);
  assert.equal(staleHead({ ...paused, queue: [item('r1', '判断', { reply: true })] }, staleKey), null);
  assert.equal(staleHead(agent({ queuePaused: true }), staleKey), null);
});

test('古いかどうか分からない間も、古い判断が理由の一時停止なら、古い判断の扱いを選ぶ再開ボタンを出す', () => {
  // 会話の取得に失敗し続けるなどで openKey が分からないままでも、「再開」を押して照合で再び止まるだけにならないようにします
  const head = item('r1', '判断', { reply: true, proposal: openKey });
  for (const queueNote of [STALE_REPLY_NEW_PROPOSAL_NOTE, STALE_REPLY_ANSWERED_NOTE]) {
    const paused = agent({ queue: [head, item('x1')], queuePaused: true, queueNote });
    assert.equal(staleHead(paused, undefined), head, queueNote);
    // 先頭が判断でない、対象の記録がない判断は、サーバが照合せずに送るので通常の再開にします
    assert.equal(staleHead({ ...paused, queue: [item('x1'), head] }, undefined), null);
    assert.equal(staleHead({ ...paused, queue: [item('r1', '判断', { reply: true })] }, undefined), null);
    assert.equal(staleHead({ ...paused, queuePaused: false }, undefined), null);
  }
  // 古い判断以外の理由（手動・提案・中断など）で止まっている場合は通常の再開です
  for (const queueNote of [MANUAL_PAUSE_NOTE, PROPOSAL_PAUSE_NOTE, INTERRUPT_PAUSE_NOTE, ERROR_PAUSE_NOTE]) {
    assert.equal(staleHead(agent({ queue: [head], queuePaused: true, queueNote }), undefined), null, queueNote);
  }
  // 古いかどうかが分かるときは、一時停止の理由ではなく照合の結果で決めます（対象の提案がまだ判断待ちなら通常の再開）
  assert.equal(staleHead(agent({ queue: [head], queuePaused: true, queueNote: STALE_REPLY_ANSWERED_NOTE }), openKey), null);
});

test('「先頭を今すぐ送信」の説明には、先頭が古い判断のときだけ照合せずに送ることを添える', () => {
  const head = item('r1', '判断', { reply: true, proposal: openKey });
  const paused = agent({ queue: [head], queuePaused: true, queueNote: STALE_REPLY_ANSWERED_NOTE });
  assert.match(sendNextTitle(paused, null), /^一時停止中でも先頭の 1 件だけを送信します。.*照合せずに/);
  assert.match(sendNextTitle(paused, undefined), /照合せずに/);
  assert.equal(sendNextTitle(paused, openKey), '一時停止中でも先頭の 1 件だけを送信します');
  assert.equal(sendNextTitle(agent({ queue: [item('x1')] }), null), '一時停止中でも先頭の 1 件だけを送信します');
});

test('キューの描き直しの判定値は、判断待ちの提案が「分からない」と「ない」を区別する', () => {
  // JSON.stringify は undefined を null に変えるため、そのまま組み立てると両者の変化で描き直されなくなります
  const a = agent({ id: 'a1', queue: [item('r1', '判断', { reply: true, proposal: openKey })] });
  assert.notEqual(queueSignature(a, undefined), queueSignature(a, null));
  assert.notEqual(queueSignature(a, null), queueSignature(a, openKey));
  assert.equal(queueSignature(a, openKey), queueSignature({ ...a }, openKey));
  // 表示に関わる値が変わると判定値も変わります
  assert.notEqual(queueSignature(a, null), queueSignature({ ...a, queuePaused: true }, null));
  assert.notEqual(queueSignature(a, null), queueSignature({ ...a, queueNote: MANUAL_PAUSE_NOTE }, null));
  assert.notEqual(queueSignature(a, null), queueSignature({ ...a, state: 'running' }, null));
  assert.notEqual(queueSignature(a, null), queueSignature({ ...a, queue: [] }, null));
  assert.equal(queueSignature(null, undefined), '');
  // 引き継ぎの開始・終了で、一時停止・再開のボタンの表示が変わるため描き直します
  assert.notEqual(queueSignature(a, null), queueSignature({ ...a, handoff: { stage: 'memo' } }, null));
  assert.equal(queueSignature(a, null), queueSignature({ ...a, handoff: { stage: 'done' } }, null));
});
