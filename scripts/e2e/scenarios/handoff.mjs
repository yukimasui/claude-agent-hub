// 「引き継いでリセット」の一連の流れを確かめます。
// 引き継ぎメモの作成 → メモの保存 → /clear → メモを付けた最初の指示の送信が自動で進み、その間はキューの項目が送られず、
// 終わった後にキューの状態が元に戻って項目が送られることを確かめます。
import fs from 'node:fs';
import { api, brief, check, createAgent, log, queue, send, soft, transcriptOf, waitFor } from '../lib.mjs';

export const description = '引き継いでリセット（メモの作成・保存 → /clear → メモ付きの再開）と、その間のキューの停止';

export default async function run() {
  const a = await createAgent({ name: 'e2e-handoff' });
  await waitFor(a.id, (x) => x.state === 'idle', '起動');
  await send(a.id, '合言葉は「みかん」です。この後の作業で使うので覚えておいてください。今は「了解」とだけ答えてください。');
  let s = await waitFor(a.id, (x) => x.state === 'done', '最初の応答');
  const firstSession = s.sessionId;
  // 応答が transcript に書き込まれるのは Stop の後になることがあるため、少し待って確かめます
  s = await waitFor(a.id, (x) => x.contextTokens > 0, 'コンテキスト量の算出', 10000).catch(() => s);
  check(s.contextTokens > 0, 'コンテキスト量が求められている', s.contextTokens);

  // 実行できない状態（実行中）では始められないことを、サーバの判定でも確かめます
  await send(a.id, 'Bash で sleep 4 を実行してから「待ちました」とだけ答えてください。');
  await waitFor(a.id, (x) => x.state === 'running', '実行中');
  const busy = await api('POST', `/api/agents/${a.id}/handoff`, { op: 'start' }).then(
    () => 'ok',
    (e) => e.status,
  );
  check(busy === 409, '実行中は引き継いでリセットを始められない', busy);
  await waitFor(a.id, (x) => x.state === 'done', '2 つ目の応答');

  await api('POST', `/api/agents/${a.id}/handoff`, { op: 'start' });
  s = await waitFor(a.id, (x) => x.handoff?.stage === 'memo', 'メモの段階');
  check(s.queuePaused, '引き継ぎの間はキューを一時停止する', brief(s));
  // 引き継ぎの間に積んだ項目は、終わるまで送られません
  await queue(a.id, { op: 'add', text: '合言葉を答えてください。合言葉だけを 1 語で答えてください。' });
  const blocked = await send(a.id, '割り込み').then(
    () => 'ok',
    (e) => e.code,
  );
  check(blocked === 'blocked', '引き継ぎの間は入力欄からの送信を拒否する', blocked);

  const seen = new Set();
  s = await waitFor(
    a.id,
    (x) => {
      if (x.handoff) seen.add(x.handoff.stage);
      // 引き継ぎが終わるまでは、キューの項目が残っていることを確かめます
      if (x.handoff && x.handoff.stage !== 'done' && x.handoff.stage !== 'failed' && x.queue.length !== 1) throw new Error(`引き継ぎの間にキューが送られました: ${brief(x)}`);
      return x.handoff?.stage === 'done' || x.handoff?.stage === 'failed';
    },
    '引き継ぎの完了',
    300000,
  );
  log(`段階: ${[...seen].join(' → ')} / ${s.handoff.message}`);
  check(s.handoff.stage === 'done', '引き継ぎが完了する', s.handoff);
  check(seen.has('clear'), '/clear の段階を通る', [...seen]);
  check(s.sessionId !== firstSession, '新しいセッションになる', { before: firstSession, after: s.sessionId });
  const memoFile = s.handoff.memoFile;
  const memo = memoFile && fs.existsSync(memoFile) ? fs.readFileSync(memoFile, 'utf8') : '';
  check(!!memo, 'メモがデータ置き場の handoffs/ に保存される', memoFile);
  soft(memo.includes('みかん'), 'メモに合言葉が含まれる', memo.slice(0, 400));

  const users = (await transcriptOf(a.id)).filter((i) => i.role === 'user').map((i) => i.text);
  check(users[0]?.startsWith('前のセッションからの引き継ぎです。'), '新しいセッションの最初の指示がメモ付きの再開の指示になる', users[0]?.slice(0, 200));

  s = await waitFor(a.id, (x) => x.queue.length === 0 && x.state === 'done', '終了後のキューの送信', 180000);
  check(!s.queuePaused, '終了後はキューの一時停止が元に戻る', brief(s));
  const replies = (await transcriptOf(a.id)).filter((i) => i.role === 'assistant').map((i) => i.text);
  soft(replies.at(-1)?.includes('みかん'), '新しいセッションでメモから合言葉を答えられる', replies.at(-1));

  await api('POST', `/api/agents/${a.id}/handoff`, { op: 'dismiss' });
  s = await waitFor(a.id, () => true, '状態の取得');
  check(s.handoff === null, '結果の表示を閉じられる', s.handoff);
}
