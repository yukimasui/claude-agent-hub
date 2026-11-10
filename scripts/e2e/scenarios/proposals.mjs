// 提案（proposals ブロック）の出力と、判断待ちの提案があるときのキューの一時停止、
// 仕分けボードと同じ方法で判断をキューに入れたときに判断から送られること、
// および判断を入れた後に対象の提案が古くなった場合は判断を送らずに一時停止することを確かめます。
import { brief, check, createAgent, log, queue, send, sleep, soft, transcriptOf, waitFor } from '../lib.mjs';
import { findOpenProposals, proposalKey } from '../../../public/triage.js';
import { PROPOSAL_PAUSE_NOTE, STALE_REPLY_ANSWERED_NOTE, STALE_REPLY_NEW_PROPOSAL_NOTE } from '../../../lib/queue.js';

export const description = '提案ブロックの出力と、判断待ちの提案があるときのキューの一時停止・判断のキュー追加・古くなった判断の一時停止';

const userTexts = async (id) => (await transcriptOf(id)).filter((i) => i.role === 'user').map((i) => i.text);

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
  // 文言を変えたときにも判定の食い違いに気づけるよう、正規表現ではなくサーバの定数と比べます
  check(s.queueNote === PROPOSAL_PAUSE_NOTE, '一時停止の理由が表示される', s.queueNote);

  // 仕分けボードの「キューに追加」と同じく reply と対象の提案の識別子を付けて追加し、手動の操作なしに判断から送られることを確かめます
  const first = findOpenProposals(items);
  const firstKey = first ? proposalKey(first) : null;
  check(!!firstKey, '判断待ちの提案を画面と同じ方法で特定できる');
  const reply = 'すべて却下します。「判断を受け取りました」とだけ答えてください。';
  const r = await queue(a.id, { op: 'add', text: reply, reply: true, proposal: firstKey });
  check(r.queue[0]?.text === reply && r.queue.length === 2, '判断はキューの先頭に入る', JSON.stringify(r.queue));
  s = await waitFor(a.id, (x) => !x.queue.length && x.state === 'done', 'キューの送信完了', 240000);
  check(!s.queuePaused, '判断の送信後は再び一時停止しない', brief(s));
  const users = await userTexts(a.id);
  const iReply = users.findIndex((t) => t.includes('判断を受け取りました'));
  const iItem = users.findIndex((t) => t.includes('キューの項目'));
  check(iReply >= 0 && iItem > iReply, '判断がほかの項目より先に送られる', JSON.stringify(users.slice(-3)));

  // ---- 古くなった判断 ----
  // 返答済みの最初の提案への判断を入れると、重ねて送らずに一時停止します（Claude は動かないのでトークンを使いません）
  const stale = '古い判断です。「古い判断を受け取りました」とだけ答えてください。';
  await queue(a.id, { op: 'add', text: stale, reply: true, proposal: firstKey });
  s = await waitFor(a.id, (x) => x.queuePaused, '返答済みの提案への判断による一時停止', 20000);
  check(s.queueNote === STALE_REPLY_ANSWERED_NOTE, '返答済みの提案への判断は送らずに一時停止し、理由を表示する', s.queueNote);

  // 古い判断による一時停止のまま新しい提案を出させ、単に「再開」したときに古い判断が新しい提案への返答として送られず、
  // 押した時点の状況で照合し直した理由（返答済みではなく、新しい提案が出たため）で再び一時停止することを確かめます
  await send(a.id, 'README.md の改善案をもう一度 2 つ考えて、どれを採用するか私に個別に判断させてください。ファイルは変更しないでください。');
  await waitFor(a.id, (x) => x.state === 'running', '実行中');
  s = await waitFor(a.id, (x) => x.state === 'done', '2 つ目の提案の応答完了', 180000);
  const second = findOpenProposals(await transcriptOf(a.id));
  if (!soft(!!second && proposalKey(second) !== firstKey, '新しい提案が出る')) {
    log('新しい提案ブロックが無いため、新しい提案による一時停止は確認できませんでした');
    return;
  }
  check(s.queuePaused && s.queueNote === STALE_REPLY_ANSWERED_NOTE, '古い判断による一時停止が続いている', brief(s));
  await queue(a.id, { op: 'resume' });
  s = await waitFor(a.id, (x) => x.queuePaused, '再開後の照合による一時停止', 20000);
  check(s.queueNote === STALE_REPLY_NEW_PROPOSAL_NOTE, '単に再開すると照合し直し、新しい提案が出たことを理由に再び一時停止する', s.queueNote);
  check(s.queue.length === 1 && s.queue[0].text === stale, '古い判断はキューに残る', JSON.stringify(s.queue));
  check(!(await userTexts(a.id)).some((t) => t.includes('古い判断を受け取りました')), '古い判断は送られていない');

  // 画面の「古い判断を送って再開」と同じ操作で、古い判断をそのまま送ります
  await queue(a.id, { op: 'resume', staleReply: 'send', itemId: s.queue[0].id });
  s = await waitFor(a.id, (x) => !x.queue.length && x.state === 'done', '古い判断の送信完了', 180000);
  check((await userTexts(a.id)).some((t) => t.includes('古い判断を受け取りました')), '「古い判断を送って再開」で古い判断をそのまま送る');
}
