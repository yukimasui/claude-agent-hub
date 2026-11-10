// 計画モードの ExitPlanMode に対する修正依頼と、モードを指定した承認を確かめます。
import fs from 'node:fs';
import path from 'node:path';
import { brief, check, createAgent, getWorkdir, log, pendingOf, respond, soft, transcriptOf, waitFor } from '../lib.mjs';

export const description = '計画の修正依頼と、編集を自動承認するモードでの承認';

export default async function run() {
  const a = await createAgent({
    name: 'e2e-plan',
    permissionMode: 'plan',
    prompt: 'plan.md というファイルを作る計画を2ステップで立てて ExitPlanMode で提示してください。調査は不要です。承認されたら plan.md に「ok」と書いてください。',
  });

  let s = await waitFor(a.id, (x) => x.pending.some((p) => p.kind === 'plan'), '計画の表示');
  log(brief(s));
  const [p] = await pendingOf(a.id);
  check(typeof p.request.tool_input.plan === 'string' && p.request.tool_input.plan.length > 0, '計画の本文を取得できる');

  await respond(a.id, { reqId: p.reqId, action: 'revise', message: '手順を1ステップにまとめ直してください。' });
  s = await waitFor(a.id, (x) => x.pending.some((q) => q.kind === 'plan' && q.reqId !== p.reqId), '修正後の計画の表示');
  log(brief(s));
  const [p2] = await pendingOf(a.id);
  await respond(a.id, { reqId: p2.reqId, action: 'approve', mode: 'acceptEdits' });
  s = await waitFor(a.id, (x) => x.state === 'done' && !x.pending.length, '承認後の応答完了', 180000);
  log(brief(s));

  const plans = (await transcriptOf(a.id)).filter((i) => i.role === 'plan');
  check(plans[0]?.status === 'rejected', '修正を依頼した計画は却下として残る', plans.map((x) => x.status));
  check(plans.at(-1)?.status === 'approved', '最後の計画は承認として残る', plans.map((x) => x.status));
  check(s.currentMode === 'acceptEdits', '承認時に指定したモードに切り替わる', s.currentMode);
  soft(fs.existsSync(path.join(getWorkdir(), 'plan.md')), '承認後に plan.md が作られる');
}
