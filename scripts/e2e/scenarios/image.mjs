// Read ツールで読んだ画像が、会話の項目に参照として載り、画像 API から取り出せることを確かめます。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { HUB_URL, brief, check, createAgent, getWorkdir, log, soft, transcriptOf, waitFor } from '../lib.mjs';

export const description = 'Read で読んだ画像の会話表示（参照）と画像 API の応答';

// Node 20 には zlib.crc32 がないため、PNG のチャンクに付ける CRC32 をここで計算します
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 白地の中央に赤い四角を描いた PNG を作ります（Claude が内容を答えられ、画面でも見分けやすい図にしています） */
function makePng(w = 240, h = 160) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // フィルタなし
    for (let x = 0; x < w; x++) {
      const red = x > w / 4 && x < (w * 3) / 4 && y > h / 4 && y < (h * 3) / 4;
      raw.set(red ? [220, 30, 30] : [255, 255, 255], y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 ビット、RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export default async function run() {
  const png = makePng();
  fs.writeFileSync(path.join(getWorkdir(), 'shape.png'), png);

  const a = await createAgent({
    name: 'e2e-image',
    prompt: 'Read ツールで shape.png を 1 回だけ読み、写っている図形の色と形を 1 文で答えてください。ほかのツールは使わないでください。',
  });
  const s = await waitFor(a.id, (x) => x.state === 'done', '応答完了');
  log(brief(s));

  const items = await transcriptOf(a.id);
  const read = items.find((i) => i.role === 'tool' && i.name === 'Read' && i.images?.length);
  check(!!read, 'Read の項目に画像の参照が付く', items.filter((i) => i.role === 'tool'));
  if (!read) return;
  const [im] = read.images;
  log(`画像の参照: ${JSON.stringify(im)}`);
  check(im.mime === 'image/png' && im.width === 240 && im.height === 160, '参照に MIME タイプと寸法が入る', im);

  // 会話 API の応答に画像の base64 が含まれないことを確かめます（transcript には同じ画像が base64 で記録されています）
  const raw = await (await fetch(`${HUB_URL}/api/agents/${a.id}/transcript`)).text();
  check(!raw.includes(png.toString('base64').slice(0, 200)), '会話 API の応答に画像の base64 が含まれない');

  const r = await fetch(`${HUB_URL}/api/agents/${a.id}/images/${encodeURIComponent(im.ref)}`);
  const body = Buffer.from(await r.arrayBuffer());
  check(r.status === 200, '画像 API が画像を返す', r.status);
  check(r.headers.get('content-type') === 'image/png', 'Content-Type が image/png に固定される', r.headers.get('content-type'));
  check(r.headers.get('x-content-type-options') === 'nosniff', 'nosniff が付く', r.headers.get('x-content-type-options'));
  // Claude Code が画像を変換して記録する場合もあるため、元のファイルと同じかどうかは参考扱いにします
  soft(body.equals(png), '画像 API の内容が読んだファイルと一致する', { size: body.length, original: png.length });

  const other = await fetch(`${HUB_URL}/api/agents/${a.id}/images/${encodeURIComponent(im.ref.replace(/\.\d+$/, '.9'))}`);
  check(other.status === 404, 'transcript にない参照は 404 になる', other.status);

  const last = items.filter((i) => i.role === 'assistant').pop();
  soft(/赤|red/i.test(last?.text || ''), 'Claude が画像の内容（赤い図形）を答える', last?.text);
}
