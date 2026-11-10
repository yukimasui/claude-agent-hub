// 処理中に送った発言（軌道修正の指示など）が、会話表示に利用者の発言として 1 回だけ、送った位置に表示されることを確かめます。
import { brief, check, createAgent, log, send, sleep, soft, transcriptOf, waitFor } from '../lib.mjs';

export const description = '処理中に送った発言の会話表示（取り込まれた位置・目印・二重表示の有無）';

const FIRST = '「sleep 開始」と書いてから、Bash で sleep 8 を 1 回ずつ、合計 3 回実行してください。終わったら「完了」とだけ答えてください。';
const MID = '方針の追加です。最後の返答には「追加指示を受け取りました」も含めてください。';

export default async function run() {
  // sleep は作業ディレクトリの設定で許可済みなので、確認なしで実行中の時間を作れます
  const a = await createAgent({ name: 'e2e-midturn', prompt: FIRST });
  await waitFor(a.id, (x) => x.state === 'running', '実行中');
  // 最初の sleep の実行中に届くよう、少し待ってから送ります
  await sleep(3000);
  await send(a.id, MID);
  const s = await waitFor(a.id, (x) => x.state === 'done', '応答完了', 180000);
  log(brief(s));

  const items = await transcriptOf(a.id);
  const users = items.filter((i) => i.role === 'user');
  log(`利用者の発言: ${JSON.stringify(users.map((u) => ({ text: u.text.slice(0, 30), queued: !!u.queued, ts: u.ts })))}`);
  const mids = users.filter((u) => u.text === MID);
  check(mids.length === 1, '処理中に送った発言が 1 回だけ表示される', mids.length);
  const mid = mids[0];
  if (!mid) return;
  // 作業の途中で取り込まれた場合だけ目印が付きます。ターンの終了後に送られた場合は通常の発言になるため、参考扱いにします
  soft(mid.queued === true, '作業の途中で取り込まれ、処理中に送った目印が付く', mid);

  const idx = items.indexOf(mid);
  const before = items.slice(0, idx);
  const after = items.slice(idx + 1);
  check(before.some((i) => i.role === 'user' && i.text === FIRST), '最初の依頼より後に並ぶ', items.map((i) => i.role));
  if (mid.queued) {
    // 取り込まれた発言の後ろには、まだ残っている sleep の実行と最後の返答が続きます
    check(after.some((i) => i.role === 'assistant'), '発言の後ろに、その後のエージェントの返答が並ぶ', items.map((i) => i.role));
    const t = Date.parse(mid.ts);
    check(after.every((i) => !Number.isFinite(Date.parse(i.ts)) || Date.parse(i.ts) >= t), '発言の後ろには、送信より後の項目だけが並ぶ', { ts: mid.ts, after: after.map((i) => i.ts) });
  }
  const last = items.filter((i) => i.role === 'assistant').pop();
  soft(/追加指示を受け取りました/.test(last?.text || ''), 'エージェントが処理中の指示に従う', last?.text);
}
