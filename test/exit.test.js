// 詳細のヘッダーの「終了」（/exit の送信）のテストです。終了を送れるかどうかの判定（public/exit.js）と、
// 送ってからプロセスが終わるまでの送信ガード・キューの自動送信の扱い、終わったときと終わらなかったときの印の外し方（lib/queue.js）を確かめます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXITING_REASON, exitBlockReason } from '../public/exit.js';
import {
  CLEAR_UNCONFIRMED_PAUSE_NOTE, ERROR_PAUSE_NOTE, EXIT_UNCONFIRMED_PAUSE_NOTE, EXIT_WAIT_MS, INTERRUPT_PAUSE_NOTE, LOCAL_COMMAND_PAUSE_NOTE,
  MANUAL_PAUSE_NOTE, PROPOSAL_PAUSE_NOTE, STALE_REPLY_ANSWERED_NOTE, STALE_REPLY_NEW_PROPOSAL_NOTE,
  applyQueueOp, dispatchStartStep, exitWatchPatch, readyForNext, sendBlockReason,
} from '../lib/queue.js';

/** 終了を送ってよい状態（待機中）のエージェントを基本に、指定したフィールドだけを変えたものを作ります */
const agent = (fields = {}) => ({ alive: true, state: 'idle', pending: [], handoff: null, queue: [], queuePaused: false, queueNote: '', ...fields });
const item = (id) => ({ id, text: `task ${id}`, clearFirst: false, createdAt: 1 });

// ---------- 終了を送れるかどうか ----------

test('待機中・応答完了のときだけ終了を送れる', () => {
  assert.equal(exitBlockReason(agent({ state: 'idle' })), null);
  assert.equal(exitBlockReason(agent({ state: 'done' })), null);
});

test('入力が別の場所に入る状態や作業中は、状態ごとの理由を示して送らない', () => {
  assert.match(exitBlockReason(agent({ alive: false, state: 'ended' })), /停止しています/);
  assert.match(exitBlockReason(agent({ pending: [{ reqId: 'r1' }] })), /回答待ちのダイアログ/);
  assert.match(exitBlockReason(agent({ state: 'waiting' })), /ターミナルでダイアログ/);
  assert.match(exitBlockReason(agent({ state: 'starting' })), /起動中/);
  // 実行中に /exit を入れると Claude Code の入力キューに入るなど、いつ終わるかが読めないため、先に中断してもらいます
  assert.match(exitBlockReason(agent({ state: 'running' })), /中断（Esc）してから/);
  assert.match(exitBlockReason(agent({ state: 'compacting' })), /中断（Esc）してから/);
  assert.match(exitBlockReason(agent({ handoff: { stage: 'memo' } })), /引き継いでリセット/);
  assert.match(exitBlockReason(agent({ handoff: { stage: 'clear' } })), /引き継いでリセット/);
  // SessionEnd が届いてから生存確認で停止になるまでの間です
  assert.match(exitBlockReason(agent({ state: 'ended' })), /応答完了.*待機中/);
  assert.match(exitBlockReason(null), /選択されていません/);
});

test('引き継ぎの結果を表示しているだけなら、終了を送れる', () => {
  assert.equal(exitBlockReason(agent({ handoff: { stage: 'done' } })), null);
  assert.equal(exitBlockReason(agent({ handoff: { stage: 'failed' } })), null);
});

test('終了を送った後は、プロセスが終わるまで二重に送らない', () => {
  assert.equal(exitBlockReason(agent({ exitSentAt: 1000 })), EXITING_REASON);
  // 終わった後は停止の理由が優先され、画面は「再起動」に切り替わります
  assert.match(exitBlockReason(agent({ alive: false, exitSentAt: 1000 })), /停止しています/);
});

test('送信ガードに当たる状態では、終了も送らない', () => {
  // 終了も同じくプロンプトに入力して送るため、誤入力になる状態は送信ガードより緩めません
  const cases = [
    agent({ alive: false }),
    agent({ pending: [{ reqId: 'r1' }] }),
    agent({ state: 'waiting' }),
    agent({ state: 'starting' }),
    agent({ handoff: { stage: 'memo' } }),
    agent({ exitSentAt: 1000 }),
  ];
  for (const a of cases) {
    assert.ok(sendBlockReason(a), JSON.stringify(a));
    assert.ok(exitBlockReason(a), JSON.stringify(a));
  }
});

// ---------- 送ってからプロセスが終わるまで ----------

test('終了を送った後は、入力欄からの送信も受け付けない', () => {
  assert.equal(sendBlockReason(agent({ exitSentAt: 1000 })), EXITING_REASON);
  assert.equal(sendBlockReason(agent({ exitSentAt: null })), null);
});

test('終了を送った後は「先頭を今すぐ送信」も受け付けない', () => {
  assert.throws(
    () => applyQueueOp(agent({ queue: [item('q1')], exitSentAt: 1000 }), { op: 'sendNext' }),
    (e) => e.status === 409 && e.code === 'blocked' && e.message === EXITING_REASON,
  );
});

test('終了を待っている間（busy）は、キューの次の項目を自動送信しない', () => {
  // server.js の isBusy は exitSentAt があれば busy を渡します
  const a = agent({ queue: [item('q1')], exitSentAt: 1000 });
  assert.equal(readyForNext(a, { busy: !!a.exitSentAt }), false);
  assert.deepEqual(dispatchStartStep(a, { force: true, busy: !!a.exitSentAt, readItems: () => [] }), { type: 'skip' });
  // 印が外れれば、これまでどおり送れます
  assert.equal(readyForNext(agent({ queue: [item('q1')] }), { busy: false }), true);
});

test('終了を待っていなければ何もしない', () => {
  assert.equal(exitWatchPatch(agent(), 99999), undefined);
  assert.equal(exitWatchPatch(agent({ exitSentAt: null }), 99999), undefined);
  assert.equal(exitWatchPatch(null, 99999), undefined);
});

test('プロセスが終わったら、待ち時間の内外にかかわらず印だけを外す', () => {
  assert.deepEqual(exitWatchPatch(agent({ alive: false, state: 'ended', exitSentAt: 1000 }), 1500), { exitSentAt: null });
  assert.deepEqual(exitWatchPatch(agent({ alive: false, state: 'ended', exitSentAt: 1000 }), 1000 + EXIT_WAIT_MS + 1), { exitSentAt: null });
});

test('待ち時間の内は、プロセスが残っていても待ち続ける', () => {
  assert.equal(exitWatchPatch(agent({ exitSentAt: 1000 }), 1000 + EXIT_WAIT_MS - 1), null);
  assert.equal(exitWatchPatch(agent({ state: 'ended', exitSentAt: 1000 }), 1000 + EXIT_WAIT_MS - 1), null);
});

test('待ってもプロセスが終わらなければ、印を外してキューを一時停止する', () => {
  const fields = exitWatchPatch(agent({ queue: [item('q1')], exitSentAt: 1000 }), 1000 + EXIT_WAIT_MS);
  // 印を外すのは、キューの自動送信が止まったままにならないようにするためです
  assert.equal(fields.exitSentAt, null);
  // /exit が効かずにダイアログが開いているかもしれないため、次の項目は利用者が確かめてから送ります
  assert.equal(fields.queuePaused, true);
  assert.equal(fields.queueNote, EXIT_UNCONFIRMED_PAUSE_NOTE);
  assert.match(fields.activity, /終了を確認できませんでした/);
});

test('SessionEnd が届いていれば、待ち時間を過ぎても一時停止はせず印だけを外す', () => {
  assert.deepEqual(exitWatchPatch(agent({ state: 'ended', exitSentAt: 1000 }), 1000 + EXIT_WAIT_MS), { exitSentAt: null });
});

test('終了を確認できなかったことによる一時停止は、ほかの理由と区別でき、仕分けボードからの判断の追加では解除しない', () => {
  const notes = [
    PROPOSAL_PAUSE_NOTE, MANUAL_PAUSE_NOTE, INTERRUPT_PAUSE_NOTE, ERROR_PAUSE_NOTE, STALE_REPLY_NEW_PROPOSAL_NOTE, STALE_REPLY_ANSWERED_NOTE,
    CLEAR_UNCONFIRMED_PAUSE_NOTE, LOCAL_COMMAND_PAUSE_NOTE,
  ];
  assert.ok(EXIT_UNCONFIRMED_PAUSE_NOTE);
  assert.equal(notes.includes(EXIT_UNCONFIRMED_PAUSE_NOTE), false);
  const { fields } = applyQueueOp(agent({ queuePaused: true, queueNote: EXIT_UNCONFIRMED_PAUSE_NOTE }), { op: 'add', text: '判断', reply: true });
  assert.equal('queuePaused' in fields, false);
});
