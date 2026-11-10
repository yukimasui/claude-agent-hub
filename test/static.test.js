// lib/http.js の静的ファイル配信（serveStatic）と、ETag による再検証のテストです。
// 一時ディレクトリを public/ に見立てて serveStatic だけを使う小さな HTTP サーバを立て、実際の要求と応答で確かめます
// （server.js は tmux を操作するため起動しません）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { isNotModified, serveStatic, staticEtag } from '../lib/http.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-static-'));
const publicDir = path.join(root, 'public');
fs.mkdirSync(path.join(publicDir, 'sub'), { recursive: true });
fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><p>index</p>');
fs.writeFileSync(path.join(publicDir, 'app.js'), 'console.log(1);\n');
// publicDir の外にあるファイルです。パスの細工で読めてはいけません
fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');

let server;
let port;
before(async () => {
  server = http.createServer((req, res) => serveStatic(req, res, publicDir, new URL(req.url, 'http://localhost').pathname));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => {
  // 応答が終わらない接続が残っていても、テストが終われるよう閉じます（不具合が再発したときに止まったままにしないため）
  server.closeAllConnections();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function get(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('静的ファイルは no-cache と ETag を付けて返す', async () => {
  const r = await get('/app.js');
  assert.equal(r.status, 200);
  assert.equal(r.body, 'console.log(1);\n');
  assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
  // 再読み込みで変更がすぐ反映されるよう、毎回の再検証（no-cache）は維持します
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.match(r.headers.etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  assert.equal((await get('/')).body, '<!doctype html><p>index</p>');
});

test('変更のないファイルを If-None-Match 付きで要求すると 304 を返し、本体を送らない', async () => {
  const { headers } = await get('/app.js');
  const r = await get('/app.js', { 'if-none-match': headers.etag });
  assert.equal(r.status, 304);
  assert.equal(r.body, '');
  assert.equal(r.headers.etag, headers.etag);
  assert.equal(r.headers['cache-control'], 'no-cache');
});

test('ファイルを変更すると、古い ETag での要求に新しい内容を返す', async () => {
  const file = path.join(publicDir, 'change.js');
  fs.writeFileSync(file, 'old');
  // 更新時刻を明示して、同じサイズで内容だけが変わった場合も見分けられることを確かめます
  fs.utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const first = await get('/change.js');
  assert.equal(first.body, 'old');

  fs.writeFileSync(file, 'new');
  fs.utimesSync(file, new Date(1_700_000_000_001), new Date(1_700_000_000_001));
  const r = await get('/change.js', { 'if-none-match': first.headers.etag });
  assert.equal(r.status, 200);
  assert.equal(r.body, 'new');
  assert.notEqual(r.headers.etag, first.headers.etag);
  // 新しい ETag では、再び 304 になります
  assert.equal((await get('/change.js', { 'if-none-match': r.headers.etag })).status, 304);
});

test('存在しないファイル・ディレクトリ・publicDir の外は 404 を返す', async () => {
  assert.equal((await get('/missing.js')).status, 404);
  assert.equal((await get('/sub')).status, 404);
  assert.equal((await get('/..%2Fsecret.txt')).status, 404);
  assert.equal((await get('/%2E%2E/secret.txt')).status, 404);
});

test('publicDir の外を指す正規化されていないパスは 404 を返す', () => {
  // HTTP 経由では new URL がパスの .. を先に解決してしまい、前方一致の確認まで届かないため、serveStatic を直接呼んで確かめます
  for (const pathname of ['/../secret.txt', '/sub/../../secret.txt', `/../${path.basename(publicDir)}x/secret.txt`]) {
    const res = fakeResponse();
    serveStatic({ headers: {} }, res, publicDir, pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(res.body, 'Not found', pathname);
  }
});

/** serveStatic の書き出しを記録するだけの応答オブジェクトです */
function fakeResponse() {
  return {
    status: null,
    body: '',
    writeHead(status) {
      this.status = status;
      return this;
    },
    end(body = '') {
      this.body += body;
      return this;
    },
  };
}

/**
 * 応答の途中で接続が切れても reject せず、どこまで受け取れたかを返す GET です。
 * 読み込みに失敗したときのサーバの振る舞い（エラーの応答を返すか、接続を閉じるか）を確かめるために使います。
 */
function getSettled(pathname) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', (error) => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), complete: false, error }));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), complete: res.complete }));
    });
    req.on('error', (error) => resolve({ status: null, error }));
    req.end();
  });
}

test('ファイルを開けないときは、サーバを落とさずにエラーの応答を返す', { timeout: 5000, skip: process.getuid?.() === 0 && 'root は読み取り権限のないファイルも開けるため' }, async () => {
  // 情報は取得できても開けないファイルで、情報の取得と読み込みの間にファイルが消されたり権限が変わったりした場合を再現します
  const file = path.join(publicDir, 'locked.js');
  fs.writeFileSync(file, 'locked');
  fs.chmodSync(file, 0o000);
  try {
    const r = await getSettled('/locked.js');
    assert.equal(r.status, 500);
    assert.equal(r.complete, true);
    assert.ok(!r.body.includes('locked'));
  } finally {
    fs.chmodSync(file, 0o644);
  }
  // サーバは動き続けています
  assert.equal((await get('/app.js')).status, 200);
});

test('情報の取得から開くまでの間にファイルが消されたときは、404 を返す', { timeout: 5000 }, async (t) => {
  // 情報の取得と開く処理の間の競合は実ファイルでは狙って起こせないため、開く段階で ENOENT になるストリームに差し替えて再現します
  const fake = t.mock.method(fs, 'createReadStream', () => {
    const s = new Readable({ read() {} });
    setImmediate(() => s.destroy(Object.assign(new Error('ファイルがありません'), { code: 'ENOENT' })));
    return s;
  });
  const r = await getSettled('/app.js');
  assert.equal(r.status, 404);
  assert.equal(r.complete, true);
  fake.mock.restore();
  assert.equal((await get('/app.js')).status, 200);
});

test('読み込みの途中で失敗したときは、サーバを落とさずに接続を閉じる', { timeout: 5000 }, async (t) => {
  // 開いた後の読み込みの失敗（I/O エラーなど）は実ファイルでは起こしにくいため、読み込みストリームを差し替えて再現します
  const fake = t.mock.method(fs, 'createReadStream', () => {
    const s = new Readable({ read() {} });
    setImmediate(() => {
      s.emit('open');
      s.push('part');
      setImmediate(() => s.destroy(Object.assign(new Error('読み込みに失敗しました'), { code: 'EIO' })));
    });
    return s;
  });
  const r = await getSettled('/app.js');
  // ヘッダは送った後なので、途中で切れたことがクライアントに分かるよう、正常な終わり方をさせずに接続を閉じます
  assert.equal(r.status, 200);
  assert.equal(r.complete, false);
  assert.equal(fake.mock.callCount(), 1);
  fake.mock.restore();
  assert.equal((await get('/app.js')).status, 200);
});

test('staticEtag はサイズと更新時刻のどちらが変わっても別の値になる', () => {
  const base = staticEtag({ size: 10, mtimeMs: 1_700_000_000_000.25 });
  assert.equal(base, staticEtag({ size: 10, mtimeMs: 1_700_000_000_000.25 }));
  assert.notEqual(base, staticEtag({ size: 11, mtimeMs: 1_700_000_000_000.25 }));
  // 同じミリ秒の中の変更も見分けます（マイクロ秒まで含めるため）
  assert.notEqual(base, staticEtag({ size: 10, mtimeMs: 1_700_000_000_000.5 }));
});

test('isNotModified は If-None-Match を弱い比較で判定する', () => {
  const etag = 'W/"a-1"';
  assert.equal(isNotModified({}, etag), false);
  assert.equal(isNotModified({ 'if-none-match': 'W/"a-1"' }, etag), true);
  assert.equal(isNotModified({ 'if-none-match': '"a-1"' }, etag), true);
  assert.equal(isNotModified({ 'if-none-match': '"x", W/"a-1"' }, etag), true);
  assert.equal(isNotModified({ 'if-none-match': '*' }, etag), true);
  assert.equal(isNotModified({ 'if-none-match': 'W/"a-2"' }, etag), false);
  // If-Modified-Since だけでは 304 にしません（秒単位の比較では同じ秒の変更を見落とすため）
  assert.equal(isNotModified({ 'if-modified-since': new Date(Date.now() + 86_400_000).toUTCString() }, etag), false);
});
