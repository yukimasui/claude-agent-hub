// public/churu.js のテストです。ちゅーるを近づけた先の猫の選び方と、しぐさ（気分の上書き）の時間切れ・重ね方・片付け、
// ドラッグの終わりに続くクリックの止め方を確かめます。
// DOM には触れません（ドラッグの操作は画面確認で確かめます）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLICK_GUARD_MS, NEAR_PX, activeGesture, clearGesture, createClickGuard, distanceToRect, gestureOf, nearestCat, retainGestures, setGesture,
} from '../public/churu.js';

const rect = (left, top, width = 48, height = 32) => ({ left, top, right: left + width, bottom: top + height });

test('点から矩形までの距離は、中なら 0、外なら最も近い辺や角までの距離になる', () => {
  const r = rect(100, 100);
  assert.equal(distanceToRect({ x: 120, y: 110 }, r), 0);
  assert.equal(distanceToRect({ x: 100, y: 132 }, r), 0);
  assert.equal(distanceToRect({ x: 160, y: 110 }, r), 12);
  assert.equal(distanceToRect({ x: 120, y: 90 }, r), 10);
  assert.equal(distanceToRect({ x: 151, y: 136 }, r), 5);
});

test('しきい値以内の猫のうち、いちばん近い猫を選ぶ', () => {
  const cats = [
    { id: 'a', rect: rect(10, 0) },
    { id: 'b', rect: rect(10, 50) },
    { id: 'c', rect: rect(10, 100) },
  ];
  // b の下の辺から 6px、c の上の辺から 12px の位置です
  assert.equal(nearestCat({ x: 30, y: 88 }, cats), 'b');
  assert.equal(nearestCat({ x: 30, y: 95 }, cats), 'c');
  // 猫の上に重なっていれば、その猫を選びます
  assert.equal(nearestCat({ x: 20, y: 10 }, cats), 'a');
});

test('どの猫もしきい値より遠ければ選ばない', () => {
  const cats = [{ id: 'a', rect: rect(10, 0) }];
  assert.equal(nearestCat({ x: 58 + NEAR_PX, y: 10 }, cats), 'a');
  assert.equal(nearestCat({ x: 58 + NEAR_PX + 1, y: 10 }, cats), null);
  assert.equal(nearestCat({ x: 200, y: 10 }, cats, 300), 'a');
  assert.equal(nearestCat({ x: 0, y: 0 }, []), null);
});

test('しぐさは期限の前だけ続き、期限を過ぎたら元の気分に戻す', () => {
  assert.equal(activeGesture({ mood: 'delight', until: 1000 }, 999), 'delight');
  assert.equal(activeGesture({ mood: 'delight', until: 1000 }, 1000), null);
  assert.equal(activeGesture(undefined, 0), null);
  assert.equal(activeGesture({ mood: 'lick', until: Infinity }, Number.MAX_SAFE_INTEGER), 'lick');
});

test('しぐさはエージェント ID ごとに持ち、時間切れのものは問い合わせたときに消す', () => {
  setGesture('agent-1', 'delight', 5000);
  setGesture('agent-2', 'lick', Infinity);
  assert.equal(gestureOf('agent-1', 4999), 'delight');
  assert.equal(gestureOf('agent-2', 4999), 'lick');
  assert.equal(gestureOf('agent-3', 0), null);
  assert.equal(gestureOf('agent-1', 5000), null);
  // 時間切れで消えたので、時刻を戻して問い合わせても戻りません
  assert.equal(gestureOf('agent-1', 0), null);
  clearGesture('agent-2');
  assert.equal(gestureOf('agent-2', 0), null);
});

test('しぐさを指定した取り消しは、後から設定した別のしぐさを消さない', () => {
  setGesture('agent-4', 'lick', Infinity);
  setGesture('agent-4', 'delight', 5000);
  clearGesture('agent-4', 'lick');
  assert.equal(gestureOf('agent-4', 0), 'delight');
  clearGesture('agent-4', 'delight');
  assert.equal(gestureOf('agent-4', 0), null);
});

test('喜んでいる猫にちゅーるを近づけて離したら、喜ぶしぐさを残り時間の分だけ続ける', () => {
  setGesture('agent-5', 'delight', 5000, 1000);
  // ドラッグ中に近づけた間はなめます
  setGesture('agent-5', 'lick', Infinity, 2000);
  assert.equal(gestureOf('agent-5', 2000), 'lick');
  // 離れたら喜ぶしぐさに戻り、最初に食べたときの期限で終わります
  clearGesture('agent-5', 'lick', 3000);
  assert.equal(gestureOf('agent-5', 3000), 'delight');
  assert.equal(gestureOf('agent-5', 4999), 'delight');
  assert.equal(gestureOf('agent-5', 5000), null);
});

test('なめている間に喜ぶ時間が過ぎたら、離れたときは元の表示に戻す', () => {
  setGesture('agent-6', 'delight', 5000, 1000);
  setGesture('agent-6', 'lick', Infinity, 2000);
  assert.equal(gestureOf('agent-6', 6000), 'lick');
  clearGesture('agent-6', 'lick', 6000);
  assert.equal(gestureOf('agent-6', 6000), null);
});

test('喜んでいる猫にもう一度食べさせたら、新しい期限で喜び、前のしぐさには戻らない', () => {
  setGesture('agent-7', 'delight', 5000, 1000);
  setGesture('agent-7', 'lick', Infinity, 2000);
  // 猫の上で離したときは、なめるしぐさを取り消してから喜ぶしぐさを設定します（churu.js の finish）
  clearGesture('agent-7', 'lick', 3000);
  setGesture('agent-7', 'delight', 6500, 3000);
  assert.equal(gestureOf('agent-7', 6000), 'delight');
  assert.equal(gestureOf('agent-7', 6500), null);
});

test('しぐさを指定しない取り消しは、下に続いているしぐさも消す', () => {
  setGesture('agent-8', 'delight', 5000, 1000);
  setGesture('agent-8', 'lick', Infinity, 2000);
  clearGesture('agent-8', undefined, 3000);
  assert.equal(gestureOf('agent-8', 3000), null);
});

test('一覧にないエージェントのしぐさは片付ける', () => {
  setGesture('keep', 'delight', 5000, 1000);
  setGesture('gone', 'delight', 5000, 1000);
  retainGestures(['keep']);
  assert.equal(gestureOf('keep', 2000), 'delight');
  assert.equal(gestureOf('gone', 2000), null);
  // 数値の ID も文字列の ID と同じものとして扱います
  setGesture(42, 'delight', 5000, 1000);
  retainGestures([42]);
  assert.equal(gestureOf('42', 2000), 'delight');
  retainGestures([]);
  assert.equal(gestureOf('keep', 2000), null);
  assert.equal(gestureOf('42', 2000), null);
});

test('ドラッグの終わりに続くクリックは、ちゅーるか一覧に向けたものを 1 回だけ止める', () => {
  const guard = createClickGuard(400);
  // 見張りを始める前は止めません
  assert.equal(guard.take(0, true), false);
  guard.arm(1000);
  // 一覧の外のクリックは止めず、見張りも解きません
  assert.equal(guard.take(1100, false), false);
  assert.equal(guard.take(1200, true), true);
  // 1 回止めたら、続くクリックは止めません
  assert.equal(guard.take(1250, true), false);
});

test('クリックを止める見張りは、時間が過ぎたら止めない', () => {
  const guard = createClickGuard();
  guard.arm(1000);
  assert.equal(guard.take(1000 + CLICK_GUARD_MS, true), false);
  guard.arm(2000);
  assert.equal(guard.take(2000 + CLICK_GUARD_MS - 1, true), true);
});
