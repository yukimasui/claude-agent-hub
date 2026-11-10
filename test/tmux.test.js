// lib/tmux.js のテストです。tmux そのものは起動せず、子プロセスへ入力を渡す処理を確かめます。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let execWithInput;
let home;
before(async () => {
  // lib/config.js は import した時点で環境変数を読むため、本番や開発用のデータ置き場に触れないよう一時ディレクトリを指定します
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-tmux-test-'));
  process.env.AGENT_HUB_HOME = home;
  ({ execWithInput } = await import('../lib/tmux.js'));
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('子プロセスが標準入力を読まずに終了しても、書き込みの EPIPE で落ちずに終了状態で結果を返す', async () => {
  // パイプの容量を超える入力を渡し、子プロセスが読まずに終了したときに書き込みが EPIPE になる状況を作ります
  const input = 'x'.repeat(4 << 20);
  for (let i = 0; i < 5; i++) {
    assert.equal(await execWithInput(process.execPath, ['-e', 'process.exit(0)'], input), '');
    await assert.rejects(execWithInput(process.execPath, ['-e', 'process.exit(3)'], input));
  }
});

test('入力を渡すと子プロセスの標準入力に届き、入力がなければ書き込まない', async () => {
  const echo = ['-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('['+s+']'))"];
  assert.equal(await execWithInput(process.execPath, echo, 'abc'), '[abc]');
  assert.equal(await execWithInput(process.execPath, echo), '[]');
});
