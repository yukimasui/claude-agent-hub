// 通常のツールの権限確認に対する「許可して記憶」と「理由付きの拒否」を確かめます。
import fs from 'node:fs';
import path from 'node:path';
import { brief, check, createAgent, getWorkdir, log, pendingOf, respond, waitFor } from '../lib.mjs';

export const description = '権限確認の「許可して記憶」と理由付きの拒否';

export default async function run() {
  const a = await createAgent({
    name: 'e2e-perm',
    permissionMode: 'manual',
    prompt: 'Bash で `date > now.txt` を実行してください。その後 Write ツールで perm2.txt に「hi」と書いてください。',
  });

  let s = await waitFor(a.id, (x) => x.pending.some((p) => p.kind === 'permission'), '権限確認の表示');
  log(brief(s));
  const [p] = await pendingOf(a.id);
  check(p.request.tool_name === 'Bash', '最初の確認は Bash', p.request.tool_name);
  // 「許可して記憶」で適用する提案ルールは、保存先がセッション内か作業ディレクトリの設定（localSettings）のものに限ります。
  // userSettings / projectSettings の提案まで適用すると、テストの実行で利用者自身の設定ファイルが書き換わるためです
  const SAFE_DESTINATIONS = new Set(['session', 'localSettings']);
  const suggestions = Array.isArray(p.request.permission_suggestions) ? p.request.permission_suggestions : [];
  const safe = suggestions.flatMap((sg, i) => (SAFE_DESTINATIONS.has(sg?.destination) ? [i] : []));
  if (safe.length) {
    await respond(a.id, { reqId: p.reqId, action: 'allowAlways', suggestions: safe });
  } else {
    log(`保存先が session / localSettings の提案ルールが無いため、記憶せずに許可します（提案: ${JSON.stringify(suggestions.map((sg) => sg?.destination))}）`);
    await respond(a.id, { reqId: p.reqId, action: 'allow' });
  }

  s = await waitFor(a.id, (x) => x.pending.some((q) => q.reqId !== p.reqId) || x.state === 'done', '2 つ目の確認');
  log(brief(s));
  check(s.pending.length > 0, 'Write の権限確認が表示される', brief(s));
  if (s.pending.length) {
    const [p2] = await pendingOf(a.id);
    check(p2.request.tool_name === 'Write', '2 つ目の確認は Write', p2.request.tool_name);
    await respond(a.id, { reqId: p2.reqId, action: 'deny', message: 'Write はやめて、代わりに完了報告だけしてください。' });
  }
  s = await waitFor(a.id, (x) => x.state === 'done' && !x.pending.length, '応答完了');
  log(brief(s));
  check(fs.existsSync(path.join(getWorkdir(), 'now.txt')), '許可した Bash が実行されている');
  check(!fs.existsSync(path.join(getWorkdir(), 'perm2.txt')), '拒否した Write は実行されていない');
}
