// public/timeline.js のテストです。会話表示の時刻の表記と、ターンごとの応答の所要時間の求め方を確かめます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, isTurnBusy, itemTime, turnDurations, turnLabel, turnTitle } from '../public/timeline.js';

// 地域の時刻で作った日時を ISO 形式にします。実行環境のタイムゾーンによらず、表記が同じ時刻になるようにするためです
const at = (d, h, m, s = 0) => new Date(2026, 10, d, h, m, s).toISOString();
const NOW = new Date(2026, 10, 12, 18, 0).getTime();

test('今日の時刻は時刻だけ、別の日は日付も付け、title には秒までの日時を出す', () => {
  assert.deepEqual(itemTime(at(12, 14, 32, 5), NOW), { text: '14:32', title: '2026/11/12 14:32:05', iso: at(12, 14, 32, 5) });
  assert.equal(itemTime(at(11, 9, 5), NOW).text, '11/11 9:05');
  assert.equal(itemTime(at(11, 9, 5), NOW).title, '2026/11/11 09:05:00');
});

test('時刻が読めない項目には時刻を出さない', () => {
  assert.equal(itemTime(undefined, NOW), null);
  assert.equal(itemTime('t', NOW), null);
});

test('所要時間は 1 分未満を秒だけ、1 時間未満を分と秒、1 時間以上を時間と分で表す', () => {
  assert.equal(formatDuration(0), '0秒');
  assert.equal(formatDuration(45_900), '45秒');
  assert.equal(formatDuration(60_000), '1分0秒');
  assert.equal(formatDuration(192_000), '3分12秒');
  assert.equal(formatDuration(3_900_000 + 12_000), '1時間5分');
  assert.equal(formatDuration(-5), '0秒');
});

const user = (ts, extra = {}) => ({ role: 'user', text: '依頼', ts, ...extra });
const assistant = (ts) => ({ role: 'assistant', text: '応答', ts });
const tool = (ts) => ({ role: 'tool', name: 'Bash', summary: 'ls', ts });
const system = (ts, kind, text = '') => ({ role: 'system', text, ts, ...(kind ? { kind } : {}) });

test('プロンプトから次のプロンプトの手前の最後の応答までを、その応答の位置に出す', () => {
  const items = [
    user(at(12, 10, 0)),
    assistant(at(12, 10, 0, 5)),
    tool(at(12, 10, 1)),
    assistant(at(12, 10, 3, 12)),
    user(at(12, 11, 0)),
    tool(at(12, 11, 0, 30)),
  ];
  const turns = turnDurations(items);
  assert.deepEqual([...turns.keys()], [3, 5]);
  assert.equal(turnLabel(turns.get(3)), '応答 3分12秒');
  // ツールで終わるターンは、ツールの呼び出しの位置に出します
  assert.equal(turnLabel(turns.get(5)), '応答 30秒');
});

test('実行中のエージェントでは最後のターンの所要時間を出さず、それより前のターンは出す', () => {
  const items = [user(at(12, 10, 0)), assistant(at(12, 10, 1)), user(at(12, 11, 0)), assistant(at(12, 11, 2))];
  assert.deepEqual([...turnDurations(items, { busy: true }).keys()], [1]);
  assert.deepEqual([...turnDurations(items, { busy: false }).keys()], [1, 3]);
});

test('中断したターンは、中断の位置に中断までの時間として出す', () => {
  const items = [user(at(12, 10, 0)), tool(at(12, 10, 1)), system(at(12, 10, 2, 30), 'interrupt', '中断されました'), user(at(12, 10, 5))];
  const d = turnDurations(items, { busy: true }).get(2);
  assert.equal(turnLabel(d), '中断まで 2分30秒');
  assert.equal(turnTitle(d), 'ターンの始まり（2026/11/12 10:00:00）から中断（2026/11/12 10:02:30）まで');
});

test('実行中でも、中断で終わった最後のターンは中断までの時間を出す', () => {
  const items = [user(at(12, 10, 0)), system(at(12, 10, 0, 3), 'interrupt', '中断されました')];
  assert.equal(turnLabel(turnDurations(items, { busy: true }).get(1)), '中断まで 3秒');
});

test('表示範囲の先頭でプロンプトが欠けているターンは所要時間を出さない', () => {
  const items = [assistant(at(12, 10, 0)), tool(at(12, 10, 1)), user(at(12, 10, 2)), assistant(at(12, 10, 3))];
  assert.deepEqual([...turnDurations(items).keys()], [3]);
});

test('処理中に送った発言はターンを区切らず、同じターンの所要時間に含める', () => {
  // 処理中に送った発言（queued）は送信した時刻の位置に並ぶため、ターンの途中に入ります
  const items = [user(at(12, 10, 0)), tool(at(12, 10, 1)), user(at(12, 10, 2), { queued: true }), assistant(at(12, 10, 4))];
  const turns = turnDurations(items);
  assert.deepEqual([...turns.keys()], [3]);
  assert.equal(turns.get(3).ms, 4 * 60_000);
});

test('応答のないスラッシュコマンドには所要時間を出さず、直前のターンを区切る', () => {
  const items = [
    user(at(12, 10, 0)),
    assistant(at(12, 10, 1)),
    system(at(12, 10, 5), 'command', '/effort high'),
    system(at(12, 10, 5), null, 'Set effort level to high'),
    system(at(12, 10, 6), 'command', '/clear'),
    user(at(12, 10, 7)),
    assistant(at(12, 10, 7, 20)),
  ];
  const turns = turnDurations(items);
  assert.deepEqual([...turns.keys()], [1, 6]);
  assert.equal(turns.get(1).ms, 60_000);
  assert.equal(turns.get(6).ms, 20_000);
});

test('応答が続くスラッシュコマンド（スキルなど）と完了通知はターンの始まりとして測る', () => {
  const items = [
    system(at(12, 10, 0), 'command', '/review'),
    assistant(at(12, 10, 2)),
    system(at(12, 10, 30), 'notification', '完了通知: 調査'),
    assistant(at(12, 10, 31)),
  ];
  const turns = turnDurations(items);
  assert.equal(turnLabel(turns.get(1)), '応答 2分0秒');
  assert.equal(turnLabel(turns.get(3)), '応答 1分0秒');
});

test('ターンの途中の会話の圧縮やコマンドの出力ではターンを区切らない', () => {
  // 自動の圧縮はターンの途中で起き、その後も同じターンが続きます
  const items = [user(at(12, 10, 0)), tool(at(12, 10, 1)), { role: 'compact', text: '要約', ts: at(12, 10, 2) }, assistant(at(12, 10, 3))];
  const turns = turnDurations(items);
  assert.deepEqual([...turns.keys()], [3]);
  assert.equal(turns.get(3).ms, 3 * 60_000);
});

test('ターンの始まりの時刻が読めない場合は所要時間を出さない', () => {
  assert.equal(turnDurations([user('t'), assistant(at(12, 10, 0))]).size, 0);
});

test('実行中・回答待ち・圧縮中を、ターンが終わっていない状態とみなす', () => {
  for (const s of ['running', 'waiting', 'compacting']) assert.equal(isTurnBusy(s), true, s);
  for (const s of ['done', 'idle', 'ended', 'failed', 'starting', undefined]) assert.equal(isTurnBusy(s), false, String(s));
});

test('ターンの終わりの目印があれば、そこでターンを終え、画面に出ない入力で始まった後続の応答を含めない', () => {
  // サブエージェントからの報告で始まったターン（始まりの項目が画面に出ない）の応答が後ろに続く場合です
  const items = [
    user(at(12, 10, 0)),
    { ...assistant(at(12, 10, 1)), turnEnd: true },
    tool(at(12, 10, 20)),
    { ...assistant(at(12, 10, 25)), turnEnd: true },
    user(at(12, 11, 0)),
    assistant(at(12, 11, 1)),
  ];
  const turns = turnDurations(items);
  assert.deepEqual([...turns.keys()], [1, 5]);
  assert.equal(turns.get(1).ms, 60_000);
});

test('目印のある最後のターンは、実行中でも終わったものとして所要時間を出す', () => {
  // 画面に出ない入力で次のターンが始まって実行中になっている場合です
  const items = [user(at(12, 10, 0)), { ...assistant(at(12, 10, 1)), turnEnd: true }, tool(at(12, 10, 20))];
  assert.deepEqual([...turnDurations(items, { busy: true }).keys()], [1]);
});

test('目印のない記録で、ツールの実行中に届いた完了通知はターンを区切らない', () => {
  // ツールの結果を待つ間に通知が届き、その後も同じターンが続く場合です。区切ると後半だけの短い所要時間が出てしまいます
  const items = [
    user(at(12, 10, 0)),
    tool(at(12, 10, 1)),
    system(at(12, 10, 2), 'notification', '完了通知: 調査'),
    tool(at(12, 10, 3)),
    assistant(at(12, 10, 5)),
  ];
  const turns = turnDurations(items);
  assert.deepEqual([...turns.keys()], [4]);
  assert.equal(turns.get(4).ms, 5 * 60_000);
});

test('目印のない記録で、発言への応答の前に届いた完了通知はターンを区切らない', () => {
  // 続けて届いた 2 つの通知も、1 つのターンにまとめます
  const items = [
    system(at(12, 10, 0), 'notification', '完了通知: 1'),
    system(at(12, 10, 1), 'notification', '完了通知: 2'),
    assistant(at(12, 10, 2)),
  ];
  const turns = turnDurations(items);
  assert.deepEqual([...turns.keys()], [2]);
  assert.equal(turns.get(2).ms, 2 * 60_000);
  assert.deepEqual([...turnDurations([user(at(12, 10, 0)), system(at(12, 10, 1), 'notification'), assistant(at(12, 10, 3))]).keys()], [2]);
});

test('目印のない記録で、本文の応答で終わったターンや応答のないコマンドの後に届いた完了通知は新しいターンにする', () => {
  const afterReply = [user(at(12, 10, 0)), assistant(at(12, 10, 1)), system(at(12, 10, 30), 'notification'), assistant(at(12, 10, 32))];
  assert.deepEqual(
    [...turnDurations(afterReply).entries()].map(([k, d]) => [k, d.ms]),
    [
      [1, 60_000],
      [3, 2 * 60_000],
    ],
  );
  const afterCommand = [system(at(12, 10, 0), 'command', '/clear'), system(at(12, 10, 30), 'notification'), assistant(at(12, 10, 31))];
  assert.equal(turnDurations(afterCommand).get(2).ms, 60_000);
});

test('目印のある記録では、目印の後に届いた完了通知を新しいターンにする', () => {
  // 最後の応答がツールの呼び出しでも、目印があればターンは終わっています
  const items = [user(at(12, 10, 0)), { ...tool(at(12, 10, 1)), turnEnd: true }, system(at(12, 10, 30), 'notification'), assistant(at(12, 10, 31))];
  const turns = turnDurations(items);
  assert.equal(turns.get(1).ms, 60_000);
  assert.equal(turns.get(3).ms, 60_000);
});
