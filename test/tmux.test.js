// lib/tmux.js のテストです。tmux そのものは起動せず、子プロセスへ入力を渡す処理を確かめます。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePanes } from '../lib/panes.js';

let execWithInput, readEnviron, sendText, sendKey, capturePane, focusWindow, killWindow, setWindowState;
let home;
before(async () => {
  // lib/config.js は import した時点で環境変数を読むため、本番や開発用のデータ置き場に触れないよう一時ディレクトリを指定します
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-tmux-test-'));
  process.env.AGENT_HUB_HOME = home;
  ({ execWithInput, readEnviron, sendText, sendKey, capturePane, focusWindow, killWindow, setWindowState } = await import('../lib/tmux.js'));
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

test('プロセスの環境変数が空なら、読めなかったもの（null）として扱い、持ち主をハブのものではないと判定しない', () => {
  // 終了処理中のプロセスなどでは environ の内容が空になります。空のまま返すと、AGENT_HUB_AGENT がないことから
  // ハブのものではないペインと判定され、正しい持ち主のエージェントが「終了」になってペイン ID を消されてしまいます
  const proc = fs.mkdtempSync(path.join(home, 'proc-'));
  const write = (pid, content) => {
    fs.mkdirSync(path.join(proc, pid));
    fs.writeFileSync(path.join(proc, pid, 'environ'), content);
  };
  write('100', '');
  write('200', 'PATH=/usr/bin\0AGENT_HUB_AGENT=a1\0');
  write('300', 'PATH=/usr/bin\0');
  assert.equal(readEnviron('100', proc), null);
  assert.equal(readEnviron('200', proc).toString(), 'PATH=/usr/bin\0AGENT_HUB_AGENT=a1\0');
  assert.equal(readEnviron('999', proc), null);
  // 持ち主の判定（lib/panes.js の parsePanes）では、空の environ のペインは持ち主が分からない（null）ものになります
  const panes = parsePanes(['%1\t0\t@1\t100\t', '%2\t0\t@2\t200\t', '%3\t0\t@3\t300\t'].join('\n'), (pid) => readEnviron(pid, proc));
  assert.equal(panes.get('%1').owner, null);
  assert.equal(panes.get('%2').owner, 'a1');
  assert.equal(panes.get('%3').owner, '');
});

/**
 * PATH の先頭に偽の tmux を置いて fn を実行し、呼ばれた tmux のサブコマンドを順に返します。
 * pane は display-message（操作直前のペインの確認）と list-panes（操作直前のウィンドウ内のペインの確認）に返す行（PANE_FORMAT の形）で、
 * null ならどちらも失敗させます。capture-pane には固定の画面の文字列を返します。
 * 本物の tmux を使わないのは、利用者の tmux のセッションに触れずに、操作の手順だけを確かめるためです。
 */
async function withFakeTmux(pane, fn) {
  const dir = fs.mkdtempSync(path.join(home, 'fake-tmux-'));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(
    path.join(dir, 'tmux'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$1" >> "$FAKE_TMUX_LOG"',
      'case "$1" in',
      '  fake-check) echo fake-tmux; exit 0 ;;',
      '  display-message|list-panes) if [ -n "$FAKE_TMUX_FAIL" ]; then echo "can\'t find pane: $4" >&2; exit 1; fi; printf "%s\\n" "$FAKE_TMUX_PANE" ;;',
      '  capture-pane) echo fake-screen ;;',
      '  load-buffer) cat > /dev/null ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const saved = { PATH: process.env.PATH, FAKE_TMUX_LOG: process.env.FAKE_TMUX_LOG, FAKE_TMUX_PANE: process.env.FAKE_TMUX_PANE, FAKE_TMUX_FAIL: process.env.FAKE_TMUX_FAIL };
  Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, FAKE_TMUX_LOG: log, FAKE_TMUX_PANE: pane ?? '', FAKE_TMUX_FAIL: pane == null ? '1' : '' });
  try {
    // 万一偽の tmux が使われずに本物へ送ってしまわないよう、先に偽のものが呼ばれることを確かめます
    assert.equal((await execWithInput('tmux', ['fake-check'])).trim(), 'fake-tmux');
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return fs.readFileSync(log, 'utf8').split('\n').filter((c) => c && c !== 'fake-check');
}

const paneLine = (owner) => ['%2', '0', '@2', '', owner].join('\t');
const isForeign = (e) => e.status === 409 && e.code === 'foreign-pane' && /別のエージェント/.test(e.message);

test('送信の直前にペインのエージェント ID を確かめ、別のエージェントのペインには文字もキーも送らない', async () => {
  const calls = await withFakeTmux(paneLine('a2'), async () => {
    await assert.rejects(sendText('%2', 'こんにちは', 'a1'), isForeign);
    await assert.rejects(sendKey('%2', 'Enter', 'a1'), isForeign);
  });
  // 確かめるだけで、貼り付け（load-buffer / paste-buffer）やキーの送信（send-keys）は行いません
  assert.deepEqual(calls, ['display-message', 'display-message']);
});

test('送り先のエージェントのペインには、確かめたうえでこれまでどおり送る', async () => {
  const calls = await withFakeTmux(paneLine('a1'), async () => {
    await sendText('%2', 'こんにちは', 'a1');
    await sendKey('%2', 'Escape', 'a1');
  });
  assert.deepEqual(calls, ['display-message', 'load-buffer', 'paste-buffer', 'send-keys', 'display-message', 'send-keys']);
});

test('ペインの持ち主を確かめられないときは、送信を止めない', async () => {
  // オプションのない古いペインで、プロセスが終了して環境変数を読めない場合です（/proc のない環境も、持ち主が分からない点で同じです）
  const deadLegacy = ['%2', '1', '@2', '123', ''].join('\t');
  const legacy = await withFakeTmux(deadLegacy, () => sendText('%2', 'こんにちは', 'a1'));
  assert.deepEqual(legacy, ['display-message', 'load-buffer', 'paste-buffer', 'send-keys']);
  // ペインの確認そのものに失敗した場合も、確認の前と同じく送信を試みます（ペインがなければ送信の側で失敗します）
  const failed = await withFakeTmux(null, () => sendKey('%2', 'Enter', 'a1'));
  assert.deepEqual(failed, ['display-message', 'send-keys']);
});

/**
 * ハブのものではないペインのプロセスの代わりに、AGENT_HUB_AGENT を持たない子プロセスを起動して fn に PID を渡します。
 * エージェント ID のオプションがないペインは /proc/<pid>/environ で持ち主を求めるため、実際に読める PID が要ります。
 * 環境変数が空だと読めなかったもの（持ち主が分からない）として扱われるため、関係のない変数を 1 つだけ渡します
 */
async function withExternalProcess(fn) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: { LANG: 'C' }, stdio: 'ignore' });
  try {
    return await fn(String(child.pid));
  } finally {
    child.kill();
  }
}

test('画面の取得の直前にペインの持ち主を確かめ、別のエージェントのペインの画面は返さない', async () => {
  const calls = await withFakeTmux(paneLine('a2'), () => assert.rejects(capturePane('%2', 'a1'), (e) => isForeign(e) && /画面を取得しませんでした/.test(e.message)));
  assert.deepEqual(calls, ['display-message']);
  // ハブのものではないペインも同じです
  const external = await withExternalProcess((pid) =>
    withFakeTmux(['%2', '0', '@2', pid, ''].join('\t'), () => assert.rejects(capturePane('%2', 'a1'), isForeign)),
  );
  assert.deepEqual(external, ['display-message']);
});

test('画面の取得は、そのエージェントのペインか、持ち主を確かめられないペインならこれまでどおり行う', async () => {
  const own = await withFakeTmux(paneLine('a1'), async () => assert.equal((await capturePane('%2', 'a1')).trim(), 'fake-screen'));
  assert.deepEqual(own, ['display-message', 'capture-pane']);
  const legacy = await withFakeTmux(['%2', '1', '@2', '123', ''].join('\t'), async () => assert.equal((await capturePane('%2', 'a1')).trim(), 'fake-screen'));
  assert.deepEqual(legacy, ['display-message', 'capture-pane']);
  const failed = await withFakeTmux(null, () => capturePane('%2', 'a1'));
  assert.deepEqual(failed, ['display-message', 'capture-pane']);
});

/**
 * ウィンドウ @2 のペインの一覧（list-panes の出力）を、持ち主だけから作ります。
 * 空文字（ハブのものではないペイン）は、オプションがなく、プロセスの環境変数に AGENT_HUB_AGENT がないペインとして作るため、externalPid を使います
 */
const windowLines = (owners, externalPid = '') =>
  owners.map((owner, i) => [`%${i + 2}`, '0', '@2', owner === '' ? externalPid : '', owner ?? ''].join('\t')).join('\n');

test('削除・「tmux で表示」・ステータス行の更新の直前にウィンドウ内のペインの持ち主を確かめ、別のエージェントのウィンドウは操作しない', async () => {
  await withExternalProcess(async (pid) => {
    for (const owners of [['a2'], [''], ['a1', 'a2']]) {
      const calls = await withFakeTmux(windowLines(owners, pid), async () => {
        await assert.rejects(killWindow('@2', 'a1'), (e) => isForeign(e) && /ウィンドウを閉じませんでした/.test(e.message));
        await assert.rejects(focusWindow('@2', 'a1'), (e) => isForeign(e) && /tmux で表示しませんでした/.test(e.message));
        await assert.rejects(setWindowState('@2', 'running', 'a1'), isForeign);
      });
      // 確かめるだけで、kill-window・select-window・set-option は行いません
      assert.deepEqual(calls, ['list-panes', 'list-panes', 'list-panes'], `持ち主: ${owners}`);
    }
  });
});

test('そのエージェントのウィンドウか、持ち主を確かめられないウィンドウは、これまでどおり操作する', async () => {
  const expected = ['list-panes', 'kill-window', 'list-panes', 'select-window', 'switch-client', 'list-panes', 'set-option'];
  // 利用者がウィンドウを分割して、ハブのものではないペインが加わった場合も、自分のペインがあれば操作します
  await withExternalProcess(async (pid) => {
    for (const pane of [windowLines(['a1']), windowLines(['a1', ''], pid), windowLines([null]), null]) {
      const calls = await withFakeTmux(pane, async () => {
        await killWindow('@2', 'a1');
        await focusWindow('@2', 'a1');
        await setWindowState('@2', 'running', 'a1');
      });
      assert.deepEqual(calls, expected, `一覧: ${pane}`);
    }
  });
});
