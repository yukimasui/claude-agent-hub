// 提案（proposals ブロック）の出力と、判断待ちの提案があるときのキューの一時停止、
// および仕分けボードと同じ方法で判断をキューに入れたときに判断から送られることを確かめます。
import { brief, check, createAgent, log, queue, sleep, soft, transcriptOf, waitFor } from '../lib.mjs';

export const description = '提案ブロックの出力と、判断待ちの提案があるときのキューの一時停止・判断のキュー追加';

export default async function run() {
  const a = await createAgent({
    name: 'e2e-proposals',
    prompt: 'このディレクトリの README.md に載せる内容の改善案を3つ考えて、どれを採用するか私に個別に判断させてください。ファイルはまだ変更しないでください。',
  });
  await waitFor(a.id, (x) => x.state === 'running', '実行中');
  await queue(a.id, { op: 'add', text: '「キューの項目」とだけ答えてください。' });

  let s = await waitFor(a.id, (x) => x.state === 'done' && (x.queuePaused || !x.queue.length), '応答完了', 180000);
  // 自動送信の判定（状態変化から約 1.5 秒後）が終わるのを待ちます
  await sleep(3000);
  s = await waitFor(a.id, () => true, '状態の取得');
  log(brief(s));

  const items = await transcriptOf(a.id);
  const lastAssistant = items.filter((i) => i.role === 'assistant').at(-1);
  const hasBlock = /```proposals/.test(lastAssistant?.text || '');
  if (!soft(hasBlock, '最後の応答に proposals ブロックがある', lastAssistant?.text?.slice(0, 300))) {
    log('提案ブロックが無いため、キューの一時停止は確認できませんでした');
    return;
  }
  check(s.queuePaused && s.queue.length === 1, '判断待ちの提案があるとキューを一時停止する', brief(s));
  check(/提案/.test(s.queueNote), '一時停止の理由が表示される', s.queueNote);

  // 仕分けボードの「キューに追加」と同じく reply を付けて追加し、手動の操作なしに判断から送られることを確かめます
  const reply = 'すべて却下します。「判断を受け取りました」とだけ答えてください。';
  const r = await queue(a.id, { op: 'add', text: reply, reply: true });
  check(r.queue[0]?.text === reply && r.queue.length === 2, '判断はキューの先頭に入る', JSON.stringify(r.queue));
  s = await waitFor(a.id, (x) => !x.queue.length && x.state === 'done', 'キューの送信完了', 240000);
  check(!s.queuePaused, '判断の送信後は再び一時停止しない', brief(s));
  const users = (await transcriptOf(a.id)).filter((i) => i.role === 'user').map((i) => i.text);
  const iReply = users.findIndex((t) => t.includes('判断を受け取りました'));
  const iItem = users.findIndex((t) => t.includes('キューの項目'));
  check(iReply >= 0 && iItem > iReply, '判断がほかの項目より先に送られる', JSON.stringify(users.slice(-3)));
}
