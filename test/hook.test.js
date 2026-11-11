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

test('対話の待機中に標準入力の error が届いても、回答を待ち続けて後始末をしてから終わる', async (t) => {
  // 標準入力を読み終えた後に error が届く場合を、読み込み済みの標準入力へ error を送る前読みスクリプトで再現します
  // （実際の接続では読み終えると標準入力が閉じるため、外から起こす方法がありません）
  const dir = fs.mkdtempSync(path.join(home, 'interact-'));
  const preload = path.join(dir, 'late-stdin-error.cjs');
  fs.writeFileSync(
    preload,
    "process.stdin.once('end', () => setTimeout(() => process.stdin.emit('error', Object.assign(new Error('late'), { code: 'EIO' })), 50));\n",
  );
  // ハブが動いていると判断させるため、サーバの生存記録を書きます
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ ts: Date.now() }));
  const child = spawn(process.execPath, ['-r', preload, HOOK], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_HUB_AGENT: 'a1', AGENT_HUB_HOME: dir },
  });
  t.after(() => child.kill());
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } }));

  const reqDir = path.join(dir, 'requests');
  const reqFiles = () => (fs.existsSync(reqDir) ? fs.readdirSync(reqDir).filter((f) => f.endsWith('.json')) : []);
  const end = Date.now() + 5000;
  while (!reqFiles().length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  const [reqFile] = reqFiles();
  assert.ok(reqFile, `要求ファイルが書かれる: ${stderr}`);
  // error が届いた後も、要求を残したまま回答を待っていることを確かめます
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(child.exitCode, null, '待機を続けている');
  assert.ok(fs.existsSync(path.join(reqDir, reqFile)), '要求ファイルは残っている');

  const reqId = path.basename(reqFile, '.json');
  const output = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  const resDir = path.join(dir, 'responses');
  fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(resDir, `${reqId}.tmp`), JSON.stringify({ result: 'answered', output }));
  fs.renameSync(path.join(resDir, `${reqId}.tmp`), path.join(resDir, `${reqId}.json`));

  assert.equal(await exited, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), output);
  assert.equal(fs.existsSync(path.join(reqDir, reqFile)), false, '要求ファイルを消してから終わる');
  const events = fs.readFileSync(path.join(dir, 'events', 'a1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    events.map((e) => [e.event, e.reqId]),
    [
      ['PermissionRequest', reqId],
      ['InteractionDone', reqId],
    ],
  );
});
