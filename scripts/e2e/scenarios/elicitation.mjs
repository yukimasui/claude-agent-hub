// MCP の Elicitation（入力要求）にブラウザから回答できることを確かめます。
// 検証用の最小 MCP サーバ（../elicit-mcp.mjs）を作業ディレクトリの .mcp.json に登録して使います。
import fs from 'node:fs';
import path from 'node:path';
import { E2E_DIR, brief, check, createAgent, getWorkdir, log, pendingOf, respond, soft, transcriptOf, waitFor } from '../lib.mjs';

export const description = 'MCP の入力要求（Elicitation）へのフォーム回答';

export default async function run() {
  const dir = getWorkdir();
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { elicit: { command: process.execPath, args: [path.join(E2E_DIR, 'elicit-mcp.mjs')] } } }, null, 2),
  );
  const a = await createAgent({ name: 'e2e-elicit', prompt: 'mcp__elicit__ask_profile ツールを1回呼び出し、返ってきた結果をそのまま報告してください。' });

  let s = await waitFor(a.id, (x) => x.pending.some((p) => p.kind === 'elicitation'), '入力要求の表示');
  log(brief(s));
  const [p] = await pendingOf(a.id);
  check(p.request.mcp_server_name === 'elicit', '要求元の MCP サーバ名を取得できる', p.request.mcp_server_name);
  check(!!p.request.requested_schema?.properties?.name, '入力フォームのスキーマを取得できる', p.request.requested_schema);

  await respond(a.id, { reqId: p.reqId, action: 'accept', content: { name: 'たま', age: 3, color: 'blue', agree: true } });
  s = await waitFor(a.id, (x) => x.state === 'done' && !x.pending.length, '回答後の応答完了');
  log(brief(s));
  const last = (await transcriptOf(a.id)).filter((i) => i.role === 'assistant').at(-1);
  soft(/たま/.test(last?.text || ''), '入力した内容が Claude に届いている', last?.text?.slice(0, 300));
}
