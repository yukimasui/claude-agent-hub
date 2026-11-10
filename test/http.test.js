// lib/http.js のテストです。画像 API と同じ順序（Host / Origin の確認 → 画像 API の確認 → transcript から取り出して返す）で
// 要求を処理する小さな HTTP サーバを立て、実際の HTTP の要求と応答で確かめます（server.js は tmux を操作するため起動しません）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { IMAGE_PATH_RE, checkImageRequest, checkRequest, httpError, sendImage } from '../lib/http.js';
import { readTranscriptImage } from '../lib/transcript.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-http-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** 画像を 1 つ含む transcript を作ります */
function transcript(name, uuid, data, mediaType) {
  const file = path.join(dir, `${name}.jsonl`);
  const line = { type: 'user', uuid, timestamp: 't', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } }] } };
  fs.writeFileSync(file, JSON.stringify(line) + '\n');
  return file;
}

// エージェント ID -> transcript のパス（server.js の store.get(id).transcriptPath に当たります）
const agents = {
  a1: transcript('a1', 'u-a1', PNG, 'image/png'),
  a2: transcript('a2', 'u-a2', PNG, 'image/png'),
  svg: transcript('svg', 'u-svg', SVG, 'image/png'),
};

let server;
let port;
before(async () => {
  server = http.createServer((req, res) => {
    try {
      checkRequest(req);
      const m = new URL(req.url, 'http://localhost').pathname.match(IMAGE_PATH_RE);
      if (!m) throw httpError(404, 'Not found');
      checkImageRequest(req);
      const img = readTranscriptImage(agents[m[1]], m[2]);
      if (!img) throw httpError(404, '画像が見つかりません');
      sendImage(res, img);
    } catch (e) {
      res.writeHead(e.status || 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 指定したヘッダで GET します（fetch は Host などを書き換えられないため http.request を使います） */
function get(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('画像は Content-Type を固定し、nosniff を付けて返す', async () => {
  const r = await get('/api/agents/a1/images/u-a1.0', { 'sec-fetch-site': 'same-origin' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/png');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(Number(r.headers['content-length']), PNG.length);
  assert.deepEqual(r.body, PNG);
  // アドレス欄から直接開いた場合と、Sec-Fetch-Site を付けないクライアントも受け付けます
  assert.equal((await get('/api/agents/a1/images/u-a1.0', { 'sec-fetch-site': 'none' })).status, 200);
  assert.equal((await get('/api/agents/a1/images/u-a1.0', { origin: `http://localhost:${port}` })).status, 200);
});

test('他のエージェントの画像や transcript 以外のファイルは返さない', async () => {
  assert.equal((await get('/api/agents/a1/images/u-a2.0')).status, 404);
  assert.equal((await get('/api/agents/a1/images/u-a1.1')).status, 404);
  assert.equal((await get('/api/agents/a1/images/..%2Fa2.jsonl')).status, 404);
  assert.equal((await get('/api/agents/missing/images/u-a1.0')).status, 404);
});

test('中身が SVG の画像は、宣言が PNG でも返さない', async () => {
  const r = await get('/api/agents/svg/images/u-svg.0');
  assert.equal(r.status, 404);
  assert.ok(!r.body.includes('<script>'));
});

test('Host が localhost 以外の要求は拒否する（DNS rebinding 対策）', async () => {
  assert.equal((await get('/api/agents/a1/images/u-a1.0', { host: 'evil.example' })).status, 403);
  assert.equal((await get('/api/agents/a1/images/u-a1.0', { host: `evil.example:${port}` })).status, 403);
});

test('他のサイトからの読み込みは拒否する', async () => {
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await get('/api/agents/a1/images/u-a1.0', { 'sec-fetch-site': site })).status, 403, site);
  }
  assert.equal((await get('/api/agents/a1/images/u-a1.0', { origin: 'http://evil.example' })).status, 403);
  assert.equal((await get('/api/agents/a1/images/u-a1.0', { origin: 'not a url' })).status, 403);
});

test('sendImage は対応する形式以外を返さない', () => {
  const res = { writeHead: () => assert.fail('応答を書き出してはいけません'), end: () => assert.fail('応答を書き出してはいけません') };
  for (const mime of ['image/svg+xml', 'text/html', 'application/octet-stream', undefined]) {
    assert.throws(() => sendImage(res, { mime, data: PNG }), { status: 404 }, String(mime));
  }
  assert.throws(() => sendImage(res, { mime: 'image/png', data: 'not a buffer' }), { status: 404 });
});
