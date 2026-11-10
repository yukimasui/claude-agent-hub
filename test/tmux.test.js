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

test('入力を渡すと子プロセスの標準入力に届き、入力がなければ空のまま閉じる', async () => {
  const echo = ['-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('['+s+']'))"];
  assert.equal(await execWithInput(process.execPath, echo, 'abc'), '[abc]');
  assert.equal(await execWithInput(process.execPath, echo), '[]');
});

/**
 * fn の実行中に、子プロセスの標準入力（net.Socket）へ書き込みが行われた回数を数えます。
 * end('') は空の文字列を書き込んでから閉じ、end() は書き込まずに閉じますが、子プロセスからはどちらも空の入力に見えて区別できません。
 * そのため、ソケットへの書き込み（_write。end(chunk) は write を経由せずにこれを呼びます）の回数を数えて確かめます。
 * テストの出力（process.stdout / stderr）への書き込みは数えません。
 */
async function countStdinWrites(fn) {
  const net = await import('node:net');
  const orig = net.Socket.prototype._write;
  let n = 0;
  net.Socket.prototype._write = function (...args) {
    if (this !== process.stdout && this !== process.stderr) n++;
    return orig.apply(this, args);
  };
  try {
    await fn();
  } finally {
    net.Socket.prototype._write = orig;
  }
  return n;
}

test('入力がないときは、標準入力を読まずに終了するコマンドにも書き込まない（has-session の経路）', async () => {
  // 本番で落ちたのは、入力を渡さない tmux has-session が失敗して終了した経路です。
  // 同じく標準入力を読まずに失敗して終了するコマンドで、書き込みを一度も行わず、終了状態で失敗を返すことを確かめます
  const writes = await countStdinWrites(() => assert.rejects(execWithInput(process.execPath, ['-e', 'process.exit(1)'])));
  assert.equal(writes, 0);
  // 数え方が正しいことを確かめるため、入力を渡した場合は書き込みが数えられることも確認します
  assert.ok((await countStdinWrites(() => execWithInput(process.execPath, ['-e', 'process.exit(0)'], 'abc'))) > 0);
});
