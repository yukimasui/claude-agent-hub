// AskUserQuestion への回答（単一選択・複数選択・メモ）と、選択せずに返信する操作を確かめます。
import { brief, check, createAgent, log, pendingOf, respond, send, transcriptOf, waitFor } from '../lib.mjs';

export const description = '質問への回答（単一・複数選択とメモ）と、選択せずに返信';

export default async function run() {
  const a = await createAgent({
    name: 'e2e-question',
    prompt:
      'AskUserQuestion ツールを1回だけ使って2つ同時に質問してください。質問1: 好きな言語（単一選択。TypeScript/Python）。質問2: 使うツール（multiSelect。git/tmux/docker）。回答を受け取ったら、受け取った回答とメモをそのまま箇条書きで報告してください。',
  });

  let s = await waitFor(a.id, (x) => x.pending.some((p) => p.kind === 'question'), '質問の表示');
  log(brief(s));
  check(s.state === 'waiting', '質問が表示されると要対応になる', s.state);
  const [p] = await pendingOf(a.id);
  const qs = p.request.tool_input.questions;
  check(qs.length === 2, '2 つの質問が 1 つの要求にまとまっている', qs.length);

  const tools = [qs[1].options[0].label, qs[1].options[1].label];
  await respond(a.id, {
    reqId: p.reqId,
    action: 'answer',
    answers: { [qs[0].question]: 'Rust（その他の自由記述）', [qs[1].question]: tools },
    annotations: { [qs[0].question]: { notes: 'ブラウザからのメモです' } },
  });
  s = await waitFor(a.id, (x) => x.state === 'done' && !x.pending.length, '回答後の応答完了');
  log(brief(s));
  const answered = (await transcriptOf(a.id)).filter((i) => i.role === 'question').pop();
  check(answered?.status === 'answered', '会話に回答済みの質問として残る', answered?.status);
  check(answered?.answers?.[qs[0].question] === 'Rust（その他の自由記述）', '自由記述の回答が対応付けられる', answered?.answers);
  check(answered?.answers?.[qs[1].question] === tools.join(', '), '複数選択の回答がカンマ区切りで渡る', answered?.answers);
  check(answered?.annotations?.[qs[0].question]?.notes === 'ブラウザからのメモです', 'メモが回答に添えられる', answered?.annotations);

  // 選択肢を選ばずに返信するケースです
  await send(a.id, 'もう一度 AskUserQuestion で「好きな色（赤/青）」を1問だけ質問してください。返答を受け取ったらその内容を報告してください。');
  await waitFor(a.id, (x) => x.pending.some((q) => q.kind === 'question' && q.reqId !== p.reqId), '2 回目の質問の表示');
  const [p2] = await pendingOf(a.id);
  await respond(a.id, { reqId: p2.reqId, action: 'respond', text: '色はどちらでもないです。緑が好きです。' });
  s = await waitFor(a.id, (x) => x.state === 'done' && !x.pending.length, '返信後の応答完了');
  log(brief(s));
  const replied = (await transcriptOf(a.id)).filter((i) => i.role === 'question').pop();
  check(replied?.status === 'rejected', '返信した質問は選択されなかった扱いになる', replied?.status);
  check(/緑が好きです/.test(replied?.resultText || ''), '返信内容が Claude に伝わる', replied?.resultText);
}
