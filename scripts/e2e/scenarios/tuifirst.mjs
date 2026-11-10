// ブラウザで答えずにターミナル側で先に答えた場合に、待機中の hook が解放されることを確かめます。
import fs from 'node:fs';
import path from 'node:path';
import { api, brief, check, createAgent, getWorkdir, log, pendingOf, pidAlive, sleep, waitFor } from '../lib.mjs';

export const description = 'ターミナルで先に回答したとき、待機中の hook が解放される';

export default async function run() {
  const a = await createAgent({ name: 'e2e-tuifirst', permissionMode: 'manual', prompt: 'Write ツールで tui.txt に「tui」と書いてください。' });

  let s = await waitFor(a.id, (x) => x.pending.length, '権限確認の表示');
  log(brief(s));
  const [p] = await pendingOf(a.id);
  check(pidAlive(p.hookPid), 'hook が回答を待っている');
  // TUI のダイアログが描画されるまで少し待ってから、ターミナルに「1（はい）」を送ります
  await sleep(1500);
  await api('POST', `/api/agents/${a.id}/keys`, { key: '1' });
  s = await waitFor(a.id, (x) => x.state === 'done' && !x.pending.length, '応答完了');
  log(brief(s));
  await sleep(1500);
  check(!pidAlive(p.hookPid), '待機していた hook が終了している', p.hookPid);
  check(fs.existsSync(path.join(getWorkdir(), 'tui.txt')), 'ターミナルで許可した書き込みが実行されている');
}
