// lib/http.js の待ち受けの開始（listen）と、失敗したときのメッセージのテストです。
// server.js は tmux を操作するため起動せず、同じ処理を小さな HTTP サーバで確かめます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen, listenErrorMessage } from '../lib/http.js';

const close = (s) => new Promise((r) => s.close(r));

test('使用中のポートでは、落ちずに EADDRINUSE で reject し、原因が分かるメッセージにできる', async () => {
  const first = http.createServer();
  await listen(first, 0, '127.0.0.1');
  const { port } = first.address();
  // error を受けていないと下の await が終わらず finally で閉じられないため、このサーバがテストの終了を妨げないようにします
  first.unref();
  const second = http.createServer();
  // http.Server は内部でも listening を受けるため、呼び出す前の数と比べます
  const counts = { error: second.listenerCount('error'), listening: second.listenerCount('listening') };
  try {
    // error を受けていなければ、ここで処理されない error になり（サーバでは落ちる原因になります）、このテストは失敗します
    const err = await listen(second, port, '127.0.0.1').then(
      () => assert.fail('使用中のポートで待ち受けを開始してはいけません'),
      (e) => e,
    );
    assert.equal(err.code, 'EADDRINUSE');
    const msg = listenErrorMessage(err, port, '127.0.0.1');
    assert.match(msg, new RegExp(`ポート ${port} はすでに使われている`));
    assert.match(msg, /HUB_PORT/);
    // 失敗の後に、待ち受け用に付けた受け取り口が残らないようにします
    assert.equal(second.listenerCount('error'), counts.error);
    assert.equal(second.listenerCount('listening'), counts.listening);
  } finally {
    await close(first);
  }
});

test('待ち受けを開始できたら resolve し、受け取り口を残さない', async () => {
  const s = http.createServer((_req, res) => res.end('ok'));
  await listen(s, 0, '127.0.0.1');
  try {
    assert.equal(s.listenerCount('error'), 0);
    const body = await fetch(`http://127.0.0.1:${s.address().port}/`).then((r) => r.text());
    assert.equal(body, 'ok');
  } finally {
    await close(s);
  }
});

test('そのほかの失敗も、場所と理由をメッセージに含める', () => {
  assert.match(listenErrorMessage(Object.assign(new Error('x'), { code: 'EACCES' }), 80, '127.0.0.1'), /権限がありません.*127\.0\.0\.1:80/);
  assert.match(listenErrorMessage(new Error('something failed'), 4400, '127.0.0.1'), /127\.0\.0\.1:4400.*something failed/);
});
