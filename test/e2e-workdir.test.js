// scripts/e2e/workdir.mjs のテストです。E2E の作業ディレクトリの安全確認・整理・ロックを確かめます。
// 利用者のホームの実際のパスには触れないよう、すべて一時ディレクトリの中で行います。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCK, MARKER, USER_SUBDIR, acquireLock, clearWorkdir, inspectWorkdir, isPidAlive, prepareWorkdir, releaseLock, resolveWorkdir } from '../scripts/e2e/workdir.mjs';

/** テストごとの一時ディレクトリを作り、終了時に消します */
function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-e2e-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** すでに終了したプロセスの PID を返します（死んだプロセスのロックを再現するため） */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

const write = (p, s = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};
const lockHolder = (dir) => JSON.parse(fs.readFileSync(path.join(dir, LOCK), 'utf8')).pid;

// ---------- パスの決定 ----------

test('既定の作業ディレクトリはホームの下の固定パスになる', () => {
  assert.equal(resolveWorkdir({}, '/home/u'), path.join('/home/u', '.agent-hub-dev', 'e2e-work'));
});

test('E2E_WORKDIR を指定すると、指定先そのものではなくその下のサブディレクトリを使う', () => {
  assert.equal(resolveWorkdir({ E2E_WORKDIR: '/data/trusted' }, '/home/u'), path.join('/data/trusted', USER_SUBDIR));
});

// ---------- 安全確認 ----------

test('存在しないディレクトリでは作成して目印・設定・README を置き、ロックを取る', (t) => {
  const dir = path.join(tmp(t), 'a', 'work');
  prepareWorkdir(dir);
  assert.ok(fs.existsSync(path.join(dir, MARKER)));
  assert.ok(fs.existsSync(path.join(dir, 'README.md')));
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(settings.permissions.allow.includes('Bash(sleep:*)'));
  assert.equal(lockHolder(dir), process.pid);
  assert.equal(inspectWorkdir(dir).state, 'marked');
});

test('空のディレクトリは使ってよいと判定する', (t) => {
  const dir = tmp(t);
  assert.deepEqual(inspectWorkdir(dir), { ok: true, state: 'empty' });
  prepareWorkdir(dir);
  assert.ok(fs.existsSync(path.join(dir, MARKER)));
});

test('目印がなく空でもないディレクトリは中身を消さずに中止する', (t) => {
  const dir = tmp(t);
  write(path.join(dir, 'important.txt'), '大事なファイル');
  write(path.join(dir, 'src', 'main.js'));
  assert.equal(inspectWorkdir(dir).ok, false);
  assert.throws(() => prepareWorkdir(dir), /目印.*中止します/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['important.txt', 'src']);
  assert.equal(fs.readFileSync(path.join(dir, 'important.txt'), 'utf8'), '大事なファイル');
});

test('同じ名前でも中身の違うファイルは目印とみなさない', (t) => {
  const dir = tmp(t);
  write(path.join(dir, MARKER), 'unrelated');
  write(path.join(dir, 'keep.txt'));
  assert.throws(() => prepareWorkdir(dir), /中止します/);
  assert.ok(fs.existsSync(path.join(dir, 'keep.txt')));
});

test('シンボリックリンクは辿らずに中止する', (t) => {
  const root = tmp(t);
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  const link = path.join(root, 'link');
  fs.symlinkSync(target, link);
  assert.match(inspectWorkdir(link).reason, /シンボリックリンク/);
  assert.throws(() => prepareWorkdir(link), /中止します/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('ファイルを作業ディレクトリに指定すると中止する', (t) => {
  const file = path.join(tmp(t), 'file');
  write(file);
  assert.throws(() => prepareWorkdir(file), /ディレクトリではありません/);
});

// ---------- 整理 ----------

test('目印のあるディレクトリでは前回の生成ファイルを消して設定を作り直す', (t) => {
  const dir = tmp(t);
  prepareWorkdir(dir);
  releaseLock(dir);
  // 前回のシナリオが残したファイルと、書き換えられた設定を再現します
  write(path.join(dir, 'now.txt'));
  write(path.join(dir, 'plan.md'));
  write(path.join(dir, '.mcp.json'), '{}');
  write(path.join(dir, 'sub', 'deep', 'x.txt'));
  write(path.join(dir, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(*)"]}}');
  write(path.join(dir, '.claude', 'other.json'));

  prepareWorkdir(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.agent-hub-e2e', '.agent-hub-e2e.lock', '.claude', 'README.md']);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.claude')), ['settings.local.json']);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(!settings.permissions.allow.includes('Bash(*)'));
});

test('中身の整理は目印とロックを残し、目印がなければ何も消さない', (t) => {
  const dir = tmp(t);
  prepareWorkdir(dir);
  write(path.join(dir, 'guard.txt'));
  clearWorkdir(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.agent-hub-e2e', '.agent-hub-e2e.lock']);

  const other = tmp(t);
  write(path.join(other, 'keep.txt'));
  assert.throws(() => clearWorkdir(other), /目印/);
  assert.ok(fs.existsSync(path.join(other, 'keep.txt')));
});

// ---------- ロック ----------

test('生きている別のプロセスがロックを持っていれば中止し、中身を消さない', (t) => {
  const dir = tmp(t);
  prepareWorkdir(dir); // このテストのプロセス（生きている）がロックを持ちます
  write(path.join(dir, 'now.txt'));
  assert.throws(() => prepareWorkdir(dir, { pid: process.pid + 100000 }), new RegExp(`PID ${process.pid}.*使用中`));
  assert.ok(fs.existsSync(path.join(dir, 'now.txt')));
  assert.equal(lockHolder(dir), process.pid);
});

test('ロックの持ち主が終了していれば取り直す', (t) => {
  const dir = tmp(t);
  const dead = deadPid();
  assert.equal(isPidAlive(dead), false);
  prepareWorkdir(dir, { pid: dead });
  write(path.join(dir, 'now.txt'));
  prepareWorkdir(dir);
  assert.equal(lockHolder(dir), process.pid);
  assert.ok(!fs.existsSync(path.join(dir, 'now.txt')));
  // 取り直しの途中で使う一時ファイルが残っていないこと
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(LOCK)), [LOCK]);
});

test('壊れたロックファイルは持ち主が終了したものとして取り直す', (t) => {
  const dir = tmp(t);
  prepareWorkdir(dir);
  fs.writeFileSync(path.join(dir, LOCK), 'broken');
  acquireLock(dir);
  assert.equal(lockHolder(dir), process.pid);
});

test('ロックは持ち主だけが外せる', (t) => {
  const dir = tmp(t);
  prepareWorkdir(dir);
  releaseLock(dir, process.pid + 100000);
  assert.ok(fs.existsSync(path.join(dir, LOCK)));
  releaseLock(dir);
  assert.ok(!fs.existsSync(path.join(dir, LOCK)));
  releaseLock(dir); // ロックがなくても例外になりません
});

test('PID の判定は 0 や負の値をプロセスグループとして扱わない', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(NaN), false);
});
