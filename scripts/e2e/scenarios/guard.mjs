// ダイアログ表示中は tmux への送信を拒否し（送信ガード）、キューも止まったままになることを確かめます。
import { brief, check, createAgent, log, pendingOf, queue, respond, send, sleep, transcriptOf, waitFor } from '../lib.mjs';

export const description = '回答待ちの間の送信ガードと、回答後のキューの送信';

export default async function run() {
  const a = await createAgent({ name: 'e2e-guard', permissionMode: 'manual', prompt: 'Write ツールで guard.txt に「g」と書いてください。' });
  await waitFor(a.id, (x) => x.pending.length, '権限確認の表示');

  const r = await send(a.id, 'これはダイアログに入ってはいけない文字列です').then(
    () => ({ status: 200 }),
    (e) => ({ status: e.status, code: e.code }),
  );
  check(r.status === 409 && r.code === 'blocked', '回答待ちの間の送信は拒否される', r);

  await queue(a.id, { op: 'add', text: '「キュー後」とだけ答えてください。' });
  await sleep(3000);
  let s = await waitFor(a.id, () => true, '状態の取得');
  log(brief(s));
  check(s.queue.length === 1, '回答待ちの間はキューを送信しない', s.queue.length);

  const [p] = await pendingOf(a.id);
  await respond(a.id, { reqId: p.reqId, action: 'allow' });
  s = await waitFor(a.id, (x) => x.queue.length === 0 && x.state === 'done', 'キューの送信と応答完了');
  log(brief(s));
  const users = (await transcriptOf(a.id)).filter((i) => i.role === 'user').map((i) => i.text);
  check(!users.some((t) => t.includes('入ってはいけない')), '拒否した文字列は入力されていない', users);
  check(users.some((t) => t.includes('キュー後')), '回答後にキューの項目が送信される', users);
}
