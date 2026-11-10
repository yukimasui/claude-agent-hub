// サブエージェントの一覧と会話の読み出し（lib/subagents.js）のテストです。
// Claude Code の記録と同じ配置（<セッション ID>.jsonl と <セッション ID>/subagents/）を一時ディレクトリに作って確かめます。
// 記録の中身は、判定に使う最小限の項目だけを書いています。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSubagents, notificationsCaughtUp, readNotifications, readSubagentTranscript, subagentState, subagentsDir, tailActivity } from '../lib/subagents.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-subagents-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const sideUser = (content, ts = '2026-01-01T00:00:00.000Z') => ({ type: 'user', isSidechain: true, timestamp: ts, message: { role: 'user', content } });
/** 親の transcript に記録される完了通知の行です（実際の記録と同じく、行に timestamp があります） */
const note = (id, status, ts = new Date().toISOString()) => ({
  type: 'queue-operation',
  timestamp: ts,
  content: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
});
/** ターンの途中で取り込まれた完了通知の行（queued_command の attachment）です */
const queuedNote = (id, status, ts = new Date().toISOString()) => ({
  type: 'attachment',
  timestamp: ts,
  attachment: { type: 'queued_command', origin: { kind: 'task-notification' }, prompt: note(id, status, ts).content },
});
const sideAssistant = (content, ts = '2026-01-01T00:00:01.000Z') => ({ type: 'assistant', isSidechain: true, timestamp: ts, message: { role: 'assistant', content } });

/** 親のセッションの記録を作り、ハブのエージェントに相当するオブジェクトを返します */
function session({ parentLines = [], ...agent } = {}) {
  const transcriptPath = path.join(root, `s${++seq}.jsonl`);
  fs.writeFileSync(transcriptPath, jsonl(parentLines));
  fs.mkdirSync(subagentsDir(transcriptPath), { recursive: true });
  return { transcriptPath, alive: true, state: 'running', pending: [], ...agent };
}

/** サブエージェントの meta.json と transcript を書きます */
function addSub(parent, id, meta, lines = [sideUser('作業の依頼')]) {
  const dir = subagentsDir(parent.transcriptPath);
  fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', requestShape: 'background', spawnDepth: 1, ...meta }));
  if (lines) fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), jsonl(lines));
}

test('親の transcript の場所から subagents/ の場所を求める', () => {
  assert.equal(subagentsDir('/p/proj/abc.jsonl'), path.join('/p/proj/abc', 'subagents'));
  assert.equal(subagentsDir(null), null);
  assert.equal(subagentsDir('/p/proj/abc.txt'), null);
});

test('meta.json と transcript から説明・親子関係・状態・作業内容を組み立て、開始の古い順に並べる', () => {
  const p = session();
  addSub(p, 'a1', { description: '調査', finished: true }, [sideUser('依頼', '2026-01-01T00:00:00.000Z'), sideAssistant([{ type: 'text', text: '結果' }], '2026-01-01T00:01:00.000Z')]);
  addSub(p, 'a2', { description: '実装', spawnDepth: 1 }, [
    sideUser('依頼', '2026-01-01T00:02:00.000Z'),
    sideAssistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm   test' } }], '2026-01-01T00:03:00.000Z'),
  ]);
  addSub(p, 'a3', { description: '入れ子', parentAgentId: 'a2', spawnDepth: 2 }, [sideUser('依頼', '2026-01-01T00:04:00.000Z')]);
  // meta.json の無い transcript や、形式の違うファイルは一覧に含めません
  fs.writeFileSync(path.join(subagentsDir(p.transcriptPath), 'agent-orphan.jsonl'), jsonl([sideUser('x')]));
  fs.writeFileSync(path.join(subagentsDir(p.transcriptPath), 'notes.txt'), 'x');

  const list = listSubagents(p);
  assert.deepEqual(
    list.map((s) => [s.id, s.parentId, s.description, s.state, s.activity, s.background]),
    [
      ['a1', null, '調査', 'done', '完了しました', true],
      ['a2', null, '実装', 'running', 'Bash: npm test', true],
      ['a3', 'a2', '入れ子', 'running', '思考中…', true],
    ],
  );
  assert.equal(list[0].startedAt, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(list[1].stateSince, Date.parse('2026-01-01T00:03:00.000Z'));
});

test('transcript の最後のやり取りから作業内容を決める', () => {
  const line = (o) => JSON.stringify(o);
  assert.deepEqual(tailActivity([line(sideAssistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/x/a.md' } }]))]).activity, 'Read: /x/a.md');
  assert.equal(tailActivity([line(sideAssistant([{ type: 'tool_use', name: 'Read', input: {} }])), line(sideUser([{ type: 'tool_result', content: 'ok' }]))]).activity, '思考中…');
  // 会話以外の行や壊れた行は読み飛ばします
  assert.equal(tailActivity([line(sideUser('依頼')), '{壊れた行', line({ type: 'attachment' })]).activity, '思考中…');
  assert.equal(tailActivity([]), null);
});

test('状態の判定: 完了・失敗・中断・回答待ち', () => {
  const parent = { alive: true, state: 'running' };
  const bg = { requestShape: 'background' };
  assert.equal(subagentState({ meta: bg, parent }), 'running');
  assert.equal(subagentState({ meta: { ...bg, finished: true }, parent }), 'done');
  assert.equal(subagentState({ meta: bg, notified: 'completed', parent }), 'done');
  assert.equal(subagentState({ meta: { ...bg, finished: true }, notified: 'failed', parent }), 'failed');
  assert.equal(subagentState({ meta: bg, notified: 'killed', parent }), 'ended');
  // 利用者などが止めたものは status が stopped の通知になることがあり、実行中ではなく中断とみなします
  assert.equal(subagentState({ meta: bg, notified: 'stopped', parent }), 'ended');
  assert.equal(subagentState({ meta: bg, parent, waiting: true }), 'waiting');
  // 終了の記録がないまま親のプロセスが終わったものは中断とみなします
  assert.equal(subagentState({ meta: bg, parent: { alive: false, state: 'ended' } }), 'ended');
  assert.equal(subagentState({ meta: bg, parent: { alive: true, state: 'ended' } }), 'ended');
  // バックグラウンドのものは親の応答が終わっても動き続けますが、フォアグラウンドのものは親のターンの中でしか動きません
  assert.equal(subagentState({ meta: bg, parent: { alive: true, state: 'done' } }), 'running');
  assert.equal(subagentState({ meta: { requestShape: 'foreground' }, parent: { alive: true, state: 'done' } }), 'ended');
  assert.equal(subagentState({ meta: { requestShape: 'foreground' }, parent: { alive: true, state: 'waiting' } }), 'running');
});

test('サブエージェントからの対話要求は、そのサブエージェントを要対応にする', () => {
  const p = session();
  addSub(p, 'a1', { description: 'x' });
  addSub(p, 'a2', { description: 'y' });
  p.state = 'waiting';
  p.pending = [{ reqId: 'r1', label: '許可待ち: Bash', subagentId: 'a2' }];
  const list = listSubagents(p);
  assert.deepEqual(
    list.map((s) => [s.id, s.state, s.activity]),
    [
      ['a1', 'running', '思考中…'],
      ['a2', 'waiting', '許可待ち: Bash'],
    ],
  );
});

test('親の transcript の完了通知から失敗を読み取り、追記分も反映する', () => {
  const p = session({ parentLines: [note('a1', 'failed'), { type: 'user', message: { role: 'user', content: 'ほかの行' } }] });
  addSub(p, 'a1', { description: 'x' });
  addSub(p, 'a2', { description: 'y' });
  assert.deepEqual(listSubagents(p).map((s) => s.state), ['failed', 'running']);
  fs.appendFileSync(p.transcriptPath, jsonl([note('a2', 'completed')]));
  assert.equal(readNotifications(p.transcriptPath).get('a2').status, 'completed');
  assert.deepEqual(listSubagents(p).map((s) => s.state), ['failed', 'done']);
});

test('記録の置き場が無い、または transcript の場所が分からない場合は空の一覧にする', () => {
  assert.deepEqual(listSubagents({ transcriptPath: null }), []);
  assert.deepEqual(listSubagents({ transcriptPath: path.join(root, 'missing.jsonl') }), []);
});

test('サブエージェントの会話を、sidechain の行から表示用の項目にする', () => {
  const p = session();
  addSub(p, 'a1', { description: 'x' }, [
    sideUser('作業の依頼'),
    sideAssistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
    sideUser([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
    sideAssistant([{ type: 'text', text: '完了しました' }]),
  ]);
  const items = readSubagentTranscript(p, 'a1');
  assert.deepEqual(
    items.map((i) => [i.role, i.text || i.name]),
    [
      ['user', '作業の依頼'],
      ['tool', 'Bash'],
      ['assistant', '完了しました'],
    ],
  );
});

test('サブエージェントの会話の API は、subagents/ にある記録だけを読む', () => {
  const p = session();
  addSub(p, 'a1', { description: 'x' });
  // subagents/ の外にある transcript と、その外を指すシンボリックリンクを用意します
  const outside = path.join(root, `outside-${seq}.jsonl`);
  fs.writeFileSync(outside, jsonl([sideUser('外のファイル')]));
  const dir = subagentsDir(p.transcriptPath);
  fs.writeFileSync(path.join(dir, 'agent-link.meta.json'), '{}');
  fs.symlinkSync(outside, path.join(dir, 'agent-link.jsonl'));

  assert.ok(readSubagentTranscript(p, 'a1'));
  for (const bad of ['../a1', '..', 'a1/../a1', `../../outside-${seq}`, 'a1.jsonl', '', null, 'missing', 'link']) {
    assert.equal(readSubagentTranscript(p, bad), null, `拒否されるべき ID: ${bad}`);
  }
  // 別のエージェント（別のセッション）からは、ほかのセッションのサブエージェントを読めません
  const other = session();
  assert.equal(readSubagentTranscript(other, 'a1'), null);
});

test('親のプロセスが起動する前に更新が止まり、終了の記録もないサブエージェントは中断とみなす', () => {
  const parent = { alive: true, state: 'running', processStartedAt: 2000 };
  const bg = { requestShape: 'background' };
  // 再起動（--resume）で親が生き返っても、前のプロセスとともに止まったものは実行中に戻しません
  assert.equal(subagentState({ meta: bg, parent, lastUpdate: 1000 }), 'ended');
  assert.equal(subagentState({ meta: bg, parent, lastUpdate: 1000, waiting: true }), 'ended');
  // 今のプロセスで更新されているもの、終了の記録があるものは従来どおりです
  assert.equal(subagentState({ meta: bg, parent, lastUpdate: 3000 }), 'running');
  assert.equal(subagentState({ meta: { ...bg, finished: true }, parent, lastUpdate: 1000 }), 'done');
  // 起動時刻が分からない場合は、この判定を行いません
  assert.equal(subagentState({ meta: bg, parent: { alive: true, state: 'running' }, lastUpdate: 1000 }), 'running');
});

test('親を再起動したあとも、前のプロセスで中断したサブエージェントは「中断」のまま表示する', () => {
  const p = session();
  addSub(p, 'old', { description: '前のプロセス' });
  addSub(p, 'new', { description: '今のプロセス' });
  const dir = subagentsDir(p.transcriptPath);
  const past = new Date(Date.now() - 10 * 60 * 1000);
  for (const f of ['agent-old.jsonl', 'agent-old.meta.json']) fs.utimesSync(path.join(dir, f), past, past);
  // 親は 1 分前に再起動して生きている（alive）状態です
  p.processStartedAt = Date.now() - 60 * 1000;
  assert.deepEqual(
    listSubagents(p)
      .map((s) => [s.id, s.state, s.activity])
      .sort(),
    [
      ['new', 'running', '思考中…'],
      ['old', 'ended', '中断しました'],
    ],
  );
});

test('完了したあとに再開されて記録が続いているサブエージェントは実行中とみなす', () => {
  const p = session();
  p.processStartedAt = Date.now() - 60 * 60 * 1000;
  addSub(p, 'resumed', { description: '再開', finished: true });
  addSub(p, 'finished', { description: '完了', finished: true });
  const dir = subagentsDir(p.transcriptPath);
  // 完了の記録（meta.json）は 10 分前で、transcript はその後も更新されています
  const past = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(path.join(dir, 'agent-resumed.meta.json'), past, past);
  assert.deepEqual(listSubagents(p).map((s) => [s.id, s.state]).sort(), [
    ['finished', 'done'],
    ['resumed', 'running'],
  ]);
});

test('完了通知は 1 回の確認で読む量を制限し、残りは次の確認で読み進める', () => {
  const filler = { type: 'user', message: { role: 'user', content: 'x'.repeat(300) } };
  const p = session({ parentLines: [note('a1', 'failed'), ...Array(20).fill(filler), note('a2', 'killed')] });
  const first = readNotifications(p.transcriptPath, { limit: 1000 });
  assert.equal(first.get('a1').status, 'failed');
  assert.equal(first.has('a2'), false);
  assert.equal(notificationsCaughtUp(p.transcriptPath), false);
  let st;
  for (let i = 0; i < 20 && !notificationsCaughtUp(p.transcriptPath); i++) st = readNotifications(p.transcriptPath, { limit: 1000 });
  assert.equal(notificationsCaughtUp(p.transcriptPath), true);
  assert.equal(st.get('a2').status, 'killed');
});

test('完了通知の後に再開されたサブエージェントは、その通知を使わず実行中とみなす', () => {
  // Claude Code は再開するときに meta.json を書き直して finished を外します。最初の完了通知は親の transcript に残ります
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const p = session({ parentLines: [note('resumed', 'completed', tenMinAgo), note('finished', 'completed', tenMinAgo), note('failed', 'failed', tenMinAgo)] });
  p.processStartedAt = Date.now() - 60 * 60 * 1000;
  addSub(p, 'resumed', { description: '再開した' });
  addSub(p, 'finished', { description: '完了したまま' });
  addSub(p, 'failed', { description: '失敗したまま' });
  // 再開していないものは、記録の更新が通知より前（完了した時点）で止まっています
  const dir = subagentsDir(p.transcriptPath);
  const before = new Date(Date.parse(tenMinAgo) - 1000);
  for (const id of ['finished', 'failed']) for (const f of [`agent-${id}.jsonl`, `agent-${id}.meta.json`]) fs.utimesSync(path.join(dir, f), before, before);
  assert.deepEqual(listSubagents(p).map((s) => [s.id, s.state]).sort(), [
    ['failed', 'failed'],
    ['finished', 'done'],
    ['resumed', 'running'],
  ]);
});

test('時刻のない行（API への送信内容の記録など）にある完了通知は使わない', () => {
  // 送信内容の記録には過去の会話が含まれるため、古い通知が新しい通知を上書きしないようにします
  const blob = { type: 'api-request-blob', message: { content: [{ type: 'text', text: '<task-notification>\n<task-id>a1</task-id>\n<status>failed</status>\n</task-notification>' }] } };
  const p = session({ parentLines: [note('a1', 'completed'), blob] });
  const st = readNotifications(p.transcriptPath);
  assert.equal(st.get('a1').status, 'completed');
  assert.equal(typeof st.get('a1').ts, 'number');
});

test('完了通知は通知が届いたときの行だけから読み、ツールの結果などに引用された通知は使わない', () => {
  // ツールの結果に古い通知の文字列が引用されると、その行の新しい時刻で通知を記録し直してしまうためです
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const quoted = {
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: note('a1', 'completed').content }] },
  };
  const p = session({ parentLines: [note('a1', 'completed', tenMinAgo), quoted, queuedNote('a2', 'failed', tenMinAgo)] });
  const st = readNotifications(p.transcriptPath);
  assert.equal(st.get('a1').ts, Date.parse(tenMinAgo));
  // ターンの途中で取り込まれた通知（attachment）は読みます
  assert.equal(st.get('a2').status, 'failed');
});

test('再開した後に 2 回目の完了通知が届いたサブエージェントは、再び完了とみなす', () => {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const p = session({ parentLines: [note('r1', 'completed', tenMinAgo)] });
  p.processStartedAt = Date.now() - 60 * 60 * 1000;
  // 再開すると meta.json の finished が外れ、記録が最初の通知より後に更新されます
  addSub(p, 'r1', { description: '再開した' });
  assert.equal(listSubagents(p)[0].state, 'running');
  fs.appendFileSync(p.transcriptPath, jsonl([note('r1', 'completed', new Date(Date.now() + 1000).toISOString())]));
  assert.equal(listSubagents(p)[0].state, 'done');
});

test('完了通知より後の記録の更新は、5 秒までは完了の記録とみなし、それを超えると再開とみなす', () => {
  // 完了時の記録の更新は通知の時刻の前後にずれることがあるため、5 秒の幅を設けています（RESUME_GAP_MS）
  const t = Math.floor((Date.now() - 10 * 60 * 1000) / 1000) * 1000;
  const p = session({ parentLines: [note('edge', 'completed', new Date(t).toISOString()), note('over', 'completed', new Date(t).toISOString())] });
  p.processStartedAt = Date.now() - 60 * 60 * 1000;
  addSub(p, 'edge', { description: 'ちょうど 5 秒後' });
  addSub(p, 'over', { description: '5 秒を超えた' });
  const dir = subagentsDir(p.transcriptPath);
  const touch = (id, ms) => {
    for (const f of [`agent-${id}.jsonl`, `agent-${id}.meta.json`]) fs.utimesSync(path.join(dir, f), new Date(ms), new Date(ms));
  };
  touch('edge', t + 5000);
  touch('over', t + 5001);
  assert.deepEqual(listSubagents(p).map((s) => [s.id, s.state]).sort(), [
    ['edge', 'done'],
    ['over', 'running'],
  ]);
});

test('完了通知を読む対象がない場合は、読み終えたものとして扱う', () => {
  // 終了したエージェントの定期的な確認を省けるよう、通知を読まないままの場合も読み終えたとみなします
  assert.equal(notificationsCaughtUp(null), true);
  assert.equal(notificationsCaughtUp(path.join(root, 'missing.jsonl')), true);
  // transcript はあるが subagents/ がない場合です
  const file = path.join(root, `nodir${++seq}.jsonl`);
  fs.writeFileSync(file, jsonl([note('a1', 'completed')]));
  assert.equal(notificationsCaughtUp(file), true);
  // subagents/ がある場合は、通知を読むまでは読み終えていないとみなします
  const p = session({ parentLines: [note('a1', 'completed')] });
  assert.equal(notificationsCaughtUp(p.transcriptPath), false);
  readNotifications(p.transcriptPath);
  assert.equal(notificationsCaughtUp(p.transcriptPath), true);
});
