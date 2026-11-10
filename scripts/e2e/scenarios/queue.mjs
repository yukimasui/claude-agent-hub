// 作業中にキューへ積んだ項目が、完了後に順番に送信されることを確かめます（2 件目は /clear 付き）。
import { brief, check, createAgent, log, queue, send, sleep, waitFor } from '../lib.mjs';

export const description = '作業中に積んだキューの順次送信と /clear 付きの項目、作業中の割り込み送信';

export default async function run() {
  const a = await createAgent({ name: 'e2e-queue' });
  await waitFor(a.id, (x) => x.state === 'idle', '起動');
  const firstSession = (await waitFor(a.id, () => true, '状態の取得')).sessionId;

  // sleep は作業ディレクトリの設定で許可済みなので、確認なしで実行中の時間を作れます
  await send(a.id, 'Bash で sleep 6 を実行してから「1つ目完了」とだけ答えてください。');
  await waitFor(a.id, (x) => x.state === 'running', '実行中');
  await queue(a.id, { op: 'add', text: '「2つ目です」とだけ答えてください。' });
  await queue(a.id, { op: 'add', text: '「3つ目（clear後）です」とだけ答えてください。', clearFirst: true });
  let s = await waitFor(a.id, () => true, '状態の取得');
  log(brief(s));
  check(s.queue.length === 2, '作業中はキューに残る', s.queue.length);

  // 作業中の「今すぐ送信」は送信ガードの対象外です（軌道修正のため）
  await sleep(1500);
  const mid = await send(a.id, 'あと、最後に「割り込み了解」とも付け加えてください。').then(
    () => 'ok',
    (e) => e.message,
  );
  check(mid === 'ok', '作業中でも今すぐ送信できる', mid);

  s = await waitFor(a.id, (x) => x.queue.length === 0 && x.state === 'done', 'キューの送信完了', 240000);
  log(brief(s));
  check(s.sessionId !== firstSession, '/clear 付きの項目の前に新しいセッションになる', { before: firstSession, after: s.sessionId });
  check(!s.queuePaused, 'キューは一時停止していない', s.queueNote);
}
