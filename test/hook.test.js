// hooks/hub-hook.cjs のテストです。Claude Code は起動せず、hook のスクリプトだけを子プロセスとして実行します。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'hub-hook.cjs');

let home;
before(() => {
  // 本番や開発用のデータ置き場に書き込まないよう、一時ディレクトリを AGENT_HUB_HOME にします
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-hook-test-'));
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('標準入力の読み込みが失敗しても、終了コード 0 で終わる', async () => {
  // 標準入力を TCP の接続にし、相手側から接続をリセットして読み込みを ECONNRESET で失敗させます
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const accepted = new Promise((r) => server.once('connection', r));
    const client = net.connect(server.address().port, '127.0.0.1');
    await new Promise((r) => client.once('connect', r));
    const peer = await accepted;
    const child = spawn(process.execPath, [HOOK], {
      stdio: [client, 'ignore', 'pipe'],
      env: { ...process.env, AGENT_HUB_AGENT: 'a1', AGENT_HUB_HOME: home },
    });
    // 子プロセスに引き渡したので、こちら側の接続は閉じます（子プロセスの側は開いたままです）
    client.destroy();
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise((r) => child.once('exit', (code) => r(code)));
    // hook が読み込みを始めるのを少し待ってからリセットします
    await new Promise((r) => setTimeout(r, 300));
    peer.resetAndDestroy();
    assert.equal(await exited, 0, stderr);
    assert.doesNotMatch(stderr, /Unhandled 'error' event/);
  } finally {
    server.close();
  }
});
