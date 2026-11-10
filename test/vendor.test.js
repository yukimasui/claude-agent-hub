// 同梱している mermaid（public/vendor/mermaid/）と、画面のスクリプトの読み込み先のテストです。
// CDN の配信内容の差し替えに影響されないよう、画面が外部からスクリプトを読み込まないことを確かめます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MERMAID_SRC } from '../public/md.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor', 'mermaid');

test('mermaid はハブのサーバから配信する同梱ファイルを読み込む', () => {
  // 「/」で始まり「//」で始まらないパスは同じオリジンを指します（「//host/...」は別のホストになります）
  assert.match(MERMAID_SRC, /^\/(?!\/)/);
  assert.ok(fs.statSync(path.join(PUBLIC_DIR, MERMAID_SRC)).isFile(), `${MERMAID_SRC} が public/ にありません`);
});

test('同梱ファイルが SHA256SUMS に記録したハッシュと一致する', () => {
  // 更新手順（public/vendor/mermaid/README.md）で検証した内容から、意図せず書き換わっていないことを確かめます
  const lines = fs.readFileSync(path.join(VENDOR_DIR, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const names = [];
  for (const line of lines) {
    const [, hash, name] = line.match(/^([0-9a-f]{64}) [ *](.+)$/) || [];
    assert.ok(hash, `SHA256SUMS の形式が正しくありません: ${line}`);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(VENDOR_DIR, name))).digest('hex');
    assert.equal(actual, hash, `${name} のハッシュが一致しません`);
    names.push(name);
  }
  assert.ok(names.includes(path.basename(MERMAID_SRC)), '読み込むファイルのハッシュが記録されていません');
  assert.ok(names.includes('LICENSE'));
});

test('画面のスクリプトと HTML は外部の URL からスクリプトやスタイルを読み込まない', () => {
  const patterns = [
    /import\s*\(\s*['"`](?:https?:)?\/\//, // 動的 import
    /\bfrom\s*['"](?:https?:)?\/\//, // 静的 import
    /\bimport\s*['"](?:https?:)?\/\//, // 副作用のみの import
    /<script[^>]*\bsrc\s*=\s*['"]?(?:https?:)?\/\//i,
    /<link[^>]*\bhref\s*=\s*['"]?(?:https?:)?\/\//i,
    /\.src\s*=\s*['"`](?:https?:)?\/\//, // スクリプト要素などへの代入
    // 定数に入れてから読み込む場合（以前の MERMAID_URL など）も検出するため、スクリプトやスタイルを指す URL の文字列自体を禁止します
    /['"`](?:https?:)?\/\/[^'"`\s]+\.(?:m?js|css)(?:[?#][^'"`\s]*)?['"`]/,
  ];
  const files = fs
    .readdirSync(PUBLIC_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.(js|mjs|html)$/.test(d.name))
    .map((d) => d.name);
  assert.ok(files.includes('md.js') && files.includes('index.html'));
  for (const name of files) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
    for (const re of patterns) assert.doesNotMatch(src, re, `${name} が外部の URL を読み込んでいます`);
  }
});
