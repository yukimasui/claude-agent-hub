// lib/watch.js のテストです。監視が止まっても落ちずに張り直すことを、実際のフォルダと差し替えた監視の両方で確かめます。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchDir } from '../lib/watch.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-watch-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(20);
  }
  return true;
}

/** fs.watch の代わりに、テストから error を起こせる監視を返します */
function fakeWatch() {
  const watchers = [];
  const watch = (dir, cb) => {
    const w = Object.assign(new EventEmitter(), { dir, cb, closed: false, close: () => (w.closed = true) });
    watchers.push(w);
    return w;
  };
  return { watch, watchers };
}

test('監視中に error が届いても落ちず、記録してから張り直す', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'err-'));
  const { watch, watchers } = fakeWatch();
  const logs = [];
  const seen = [];
  const h = watchDir(dir, (_t, f) => seen.push(f), { retryMs: 20, watch, log: (m) => logs.push(m) });
  try {
    assert.equal(watchers.length, 1);
    // 受けていなければ、ここで処理されない error として例外になります（サーバでは落ちる原因になります）
    watchers[0].emit('error', Object.assign(new Error('watch failed'), { code: 'ENOSPC' }));
    assert.ok(watchers[0].closed, '止まった監視は閉じる');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /ENOSPC/);
    assert.ok(await waitFor(() => watchers.length === 2), '待ってから張り直す');
    assert.match(logs.at(-1), /再開/);
    // 張り直した監視の通知は届き、止まった監視からの通知は無視します
    watchers[1].cb('change', 'a.jsonl');
    watchers[0].cb('change', 'old.jsonl');
    assert.deepEqual(seen, ['a.jsonl']);
  } finally {
    h.close();
  }
});

test('監視を始められない間は、記録を繰り返さずに試し続ける', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'start-'));
  let fails = 3;
  let calls = 0;
  const { watch: inner, watchers } = fakeWatch();
  const watch = (...args) => {
    calls++;
    if (fails-- > 0) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    return inner(...args);
  };
  const logs = [];
  const h = watchDir(dir, () => {}, { retryMs: 10, watch, log: (m) => logs.push(m) });
  try {
    assert.ok(await waitFor(() => watchers.length === 1));
    assert.equal(calls, 4);
    assert.equal(logs.length, 2, '開始できなかったときと再開したときだけ記録する');
    assert.match(logs[0], /開始できませんでした/);
    assert.match(logs[1], /再開/);
  } finally {
    h.close();
  }
});

test('監視しているフォルダを消しても落ちず、作り直されたら監視を再開する', async () => {
  const dir = path.join(root, 'events');
  fs.mkdirSync(dir);
  const seen = new Set();
  const logs = [];
  const h = watchDir(dir, (_t, f) => f && seen.add(f), { retryMs: 30, log: (m) => logs.push(m) });
  try {
    fs.writeFileSync(path.join(dir, 'before.jsonl'), '{}\n');
    assert.ok(await waitFor(() => seen.has('before.jsonl')));

    fs.rmSync(dir, { recursive: true });
    assert.ok(await waitFor(() => logs.some((m) => /止まりました/.test(m))), '止まったことを記録する');
    // フォルダがない間も張り直しを試し続けます（例外にはなりません）
    await sleep(100);

    fs.mkdirSync(dir);
    assert.ok(await waitFor(() => logs.some((m) => /再開/.test(m))), '作り直されたフォルダの監視を再開する');
    fs.writeFileSync(path.join(dir, 'after.jsonl'), '{}\n');
    assert.ok(await waitFor(() => seen.has('after.jsonl')), '再開後の変更が通知される');
  } finally {
    h.close();
  }
});

test('close の後は張り直さない', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'close-'));
  const { watch, watchers } = fakeWatch();
  const h = watchDir(dir, () => {}, { retryMs: 10, watch, log: () => {} });
  watchers[0].emit('error', new Error('x'));
  h.close();
  await sleep(50);
  assert.equal(watchers.length, 1);
});
