// lib/store.js の状態機械のテストです。
// hook が書くのと同じ形のイベント JSONL を一時ディレクトリに追記し、ingest で読み込ませて状態を確かめます。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// lib/config.js は import 時に環境変数を読むため、本番のデータ置き場に触れないよう先に一時ディレクトリを設定します
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-'));
process.env.AGENT_HUB_HOME = home;
const { AGENTS_FILE, EVENTS_DIR, REQUESTS_DIR } = await import('../lib/config.js');
const { Store, publicAgent } = await import('../lib/store.js');
const { ERROR_PAUSE_NOTE, MANUAL_PAUSE_NOTE } = await import('../lib/queue.js');

after(() => fs.rmSync(home, { recursive: true, force: true }));

test('データ置き場が一時ディレクトリに向いている', () => {
  assert.ok(EVENTS_DIR.startsWith(home + path.sep));
});

let seq = 0;

function setup(fields = {}) {
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
  const store = new Store();
  const id = `t${++seq}`;
  store.add({ id, name: id, model: 'haiku', cwd: home, permissionMode: '', sessionId: 's0', createdAt: Date.now(), ...fields });
  const cancels = [];
  store.on('cancel', (reqId, reason) => cancels.push([reqId, reason]));
  /** イベントを追記して取り込み、最新のエージェント状態を返します */
  const emit = (...events) => {
    fs.appendFileSync(store.eventsFile(id), events.map((e) => JSON.stringify({ ts: Date.now(), ...e }) + '\n').join(''));
    store.ingest(id);
    return store.get(id);
  };
  return { store, id, emit, cancels };
}

/** hook が書き出す対話要求ファイルを作ります */
function writeRequest(reqId, fields) {
  fs.mkdirSync(REQUESTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REQUESTS_DIR, `${reqId}.json`), JSON.stringify({ reqId, event: 'PermissionRequest', hookPid: process.pid, createdAt: Date.now(), ...fields }));
}

const question = (header) => ({ questions: [{ header, question: `${header}?`, options: [{ label: 'A' }, { label: 'B' }] }] });

test('1 ターンの基本的な遷移（起動 → 実行中 → 完了）', () => {
  const { emit } = setup();
  let a = emit({ event: 'SessionStart', session_id: 's1', transcript_path: '/tmp/t.jsonl', permission_mode: 'default' });
  assert.equal(a.state, 'idle');
  assert.equal(a.activity, '入力待ち');
  assert.equal(a.sessionId, 's1');
  assert.equal(a.transcriptPath, '/tmp/t.jsonl');
  assert.equal(a.currentMode, 'default');

  a = emit({ event: 'UserPromptSubmit', prompt: 'こんにちは' });
  assert.equal(a.state, 'running');
  assert.equal(a.lastPrompt, 'こんにちは');
  assert.ok(a.turnStartedAt);

  a = emit({ event: 'PreToolUse', tool: 'Bash', tool_summary: 'ls -la' });
  assert.equal(a.activity, 'Bash: ls -la');

  a = emit({ event: 'Stop' });
  assert.equal(a.state, 'done');
  assert.equal(a.activity, '応答完了');
});

test('sessionId が変わったら agents.json に保存する', () => {
  const { id, emit } = setup();
  emit({ event: 'SessionStart', session_id: 'saved-session' });
  const saved = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find((x) => x.id === id);
  assert.equal(saved.sessionId, 'saved-session');
});

test('権限確認は要対応になり、ターミナルで先に解決されたら後続イベントで取り下げる', () => {
  const { emit, cancels } = setup();
  emit({ event: 'UserPromptSubmit', prompt: 'x' });
  writeRequest('r-perm', { tool_name: 'Bash', tool_input: { command: 'date' }, input_hash: 'h1' });
  let a = emit({ event: 'PermissionRequest', tool: 'Bash', tool_summary: 'date', input_hash: 'h1', reqId: 'r-perm' });
  assert.equal(a.state, 'waiting');
  assert.equal(a.pending.length, 1);
  assert.equal(a.pending[0].kind, 'permission');
  assert.equal(a.activity, '許可待ち: Bash');

  // 要求が残っている間は PreToolUse で実行中に戻しません
  a = emit({ event: 'PreToolUse', tool: 'Bash', tool_summary: 'date', input_hash: 'h1' });
  assert.equal(a.state, 'waiting');

  a = emit({ event: 'PostToolUse', tool: 'Bash', input_hash: 'h1' });
  assert.equal(a.pending.length, 0);
  assert.equal(a.state, 'running');
  assert.deepEqual(cancels, [['r-perm', 'resolved-elsewhere']]);
});

test('同じツールの要求が複数あれば、入力のハッシュが一致するものを取り下げる', () => {
  const { emit, cancels } = setup();
  writeRequest('r-h1', { tool_name: 'Bash', tool_input: { command: 'a' }, input_hash: 'h1' });
  writeRequest('r-h2', { tool_name: 'Bash', tool_input: { command: 'b' }, input_hash: 'h2' });
  emit({ event: 'PermissionRequest', tool: 'Bash', input_hash: 'h1', reqId: 'r-h1' }, { event: 'PermissionRequest', tool: 'Bash', input_hash: 'h2', reqId: 'r-h2' });
  const a = emit({ event: 'PostToolUseFailure', tool: 'Bash', input_hash: 'h2' });
  assert.deepEqual(a.pending.map((p) => p.reqId), ['r-h1']);
  assert.equal(a.state, 'waiting');
  assert.equal(a.activity, '許可待ち: Bash');
  assert.deepEqual(cancels, [['r-h2', 'resolved-elsewhere']]);
});

test('AskUserQuestion が再提示されたら古い要求を置き換え、件数を活動表示に出す', () => {
  const { emit, cancels } = setup();
  writeRequest('r-q1', { tool_name: 'AskUserQuestion', tool_input: question('一回目') });
  writeRequest('r-q2', { tool_name: 'AskUserQuestion', tool_input: question('二回目') });
  writeRequest('r-w', { tool_name: 'Write', tool_input: { file_path: 'x' } });
  emit({ event: 'PermissionRequest', tool: 'AskUserQuestion', reqId: 'r-q1' });
  let a = emit({ event: 'PermissionRequest', tool: 'AskUserQuestion', reqId: 'r-q2' });
  assert.deepEqual(a.pending.map((p) => p.reqId), ['r-q2']);
  assert.equal(a.pending[0].kind, 'question');
  assert.equal(a.activity, '質問: 二回目');
  assert.deepEqual(cancels, [['r-q1', 'superseded']]);

  a = emit({ event: 'PermissionRequest', tool: 'Write', reqId: 'r-w' });
  assert.equal(a.pending.length, 2);
  assert.equal(a.activity, '質問: 二回目 ほか1件');
});

test('InteractionDone は hook 自身の終了報告なので、取り下げ理由なしで要求を消す', () => {
  const { emit, cancels } = setup();
  emit({ event: 'UserPromptSubmit', prompt: 'x' });
  writeRequest('r-done', { tool_name: 'Write', tool_input: { file_path: 'x' } });
  emit({ event: 'PermissionRequest', tool: 'Write', reqId: 'r-done' });
  const a = emit({ event: 'InteractionDone', reqId: 'r-done', result: 'allow' });
  assert.equal(a.pending.length, 0);
  assert.equal(a.state, 'running');
  assert.equal(a.activity, '処理中…');
  assert.deepEqual(cancels, [['r-done', null]]);
});

test('新しいプロンプトの送信で未回答の要求はすべて解決済みとみなす', () => {
  const { emit, cancels } = setup();
  writeRequest('r-a', { tool_name: 'Write', tool_input: { file_path: 'a' } });
  writeRequest('r-b', { event: 'Elicitation', mcp_server_name: 'srv' });
  emit({ event: 'PermissionRequest', tool: 'Write', reqId: 'r-a' }, { event: 'Elicitation', mcp_server: 'srv', reqId: 'r-b' });
  assert.equal(emit().pending.length, 2);
  const a = emit({ event: 'UserPromptSubmit', prompt: '次へ' });
  assert.equal(a.pending.length, 0);
  assert.equal(a.state, 'running');
  assert.deepEqual(cancels, [['r-a', 'superseded'], ['r-b', 'superseded']]);
});

test('要求ファイルが無い対話イベント（ハブが回答できない要求）は要対応だけを表示する', () => {
  const { emit } = setup();
  let a = emit({ event: 'PermissionRequest', tool: 'Bash', tool_summary: 'rm x' });
  assert.equal(a.state, 'waiting');
  assert.equal(a.pending.length, 0);
  assert.equal(a.activity, '許可待ち: Bash: rm x');

  a = emit({ event: 'Elicitation', mcp_server: 'github', reqId: 'missing' });
  assert.equal(a.activity, '入力要求: github');
});

test('Elicitation の要求は kind が elicitation になる', () => {
  const { emit } = setup();
  writeRequest('r-el', { event: 'Elicitation', mcp_server_name: 'profile' });
  const a = emit({ event: 'Elicitation', mcp_server: 'profile', reqId: 'r-el' });
  assert.equal(a.pending[0].kind, 'elicitation');
  assert.equal(a.activity, '入力要求: profile');
});

test('StopFailure はキューを一時停止して保存し、キューが空なら一時停止しない', () => {
  const queue = [{ id: 'q1', text: '次のタスク', clearFirst: false, createdAt: 1 }];
  const { id, emit } = setup({ queue });
  emit({ event: 'UserPromptSubmit', prompt: 'x' });
  const a = emit({ event: 'StopFailure', error: 'rate_limit' });
  assert.equal(a.state, 'done');
  assert.equal(a.activity, 'エラーで停止しました: rate_limit');
  assert.equal(a.queuePaused, true);
  assert.equal(a.queueNote, ERROR_PAUSE_NOTE);
  const saved = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find((x) => x.id === id);
  assert.equal(saved.queuePaused, true);

  const empty = setup().emit({ event: 'StopFailure' });
  assert.equal(empty.queuePaused, false);
  assert.equal(empty.activity, 'エラーで停止しました');
});

test('すでに一時停止中のキューは理由を上書きしない', () => {
  const { emit } = setup({ queue: [{ id: 'q1', text: 't' }], queuePaused: true, queueNote: MANUAL_PAUSE_NOTE });
  const a = emit({ event: 'StopFailure' });
  assert.equal(a.queueNote, MANUAL_PAUSE_NOTE);
});

test('Notification は種類に応じて要対応・完了に振り分ける', () => {
  const { emit } = setup();
  emit({ event: 'UserPromptSubmit', prompt: 'x' });
  let a = emit({ event: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  assert.equal(a.state, 'waiting');
  assert.equal(a.activity, 'Claude needs your permission');
  // 要対応のままなら idle_prompt では完了にしません
  a = emit({ event: 'Notification', notification_type: 'idle_prompt' });
  assert.equal(a.state, 'waiting');

  a = emit({ event: 'Stop' }, { event: 'Notification', notification_type: 'idle_prompt' });
  assert.equal(a.state, 'done');
});

test('圧縮とセッション終了の遷移', () => {
  const { emit } = setup();
  let a = emit({ event: 'PreCompact' });
  assert.equal(a.state, 'compacting');
  a = emit({ event: 'PostCompact' });
  assert.equal(a.state, 'running');
  assert.equal(a.activity, '圧縮が完了しました');
  a = emit({ event: 'SessionEnd', reason: 'logout' });
  assert.equal(a.state, 'ended');
  assert.equal(a.activity, 'セッション終了 (logout)');
});

test('ingest は途中までの行を持ち越し、壊れた行を読み飛ばす', () => {
  const { store, id } = setup();
  const file = store.eventsFile(id);
  // マルチバイト文字の途中で書き込みが分かれても、次回の読み込みで正しくつながること
  const line = Buffer.from(JSON.stringify({ ts: 1, event: 'UserPromptSubmit', prompt: '日本語のプロンプト' }) + '\n');
  const cut = line.indexOf(Buffer.from('語')) + 1;
  fs.appendFileSync(file, 'これは JSON ではありません\n');
  fs.appendFileSync(file, line.subarray(0, cut));
  store.ingest(id);
  assert.equal(store.get(id).state, 'starting');
  fs.appendFileSync(file, line.subarray(cut));
  store.ingest(id);
  assert.equal(store.get(id).state, 'running');
  assert.equal(store.get(id).lastPrompt, '日本語のプロンプト');
});

/**
 * ファイルを開いて fstatSync で調べた直後に任意の処理を差し込んで ingest を呼びます。
 * 調べてから読むまでの間にファイルが消されたり切り詰められたりする、まれなタイミングを再現するためです。
 *
 * fs.fstatSync を一時的に差し替えますが、差し替えから復元までを 1 回の同期的な呼び出しの中で終えるので、
 * テストを並行実行にしても、ほかのテストが差し替えた関数を呼ぶことはありません。node:test の並行実行は
 * 同じスレッドの中で await の位置を境に切り替わるだけで、同期的な処理の途中に割り込まないためです
 * （ファイルごとの並行実行は別のプロセスで動くので、そもそも影響しません）。
 * このため、この関数と race には await を挟まないでください。非同期にすると、差し替えている間に
 * ほかのテストが動き、そのテストの ingest にも race が差し込まれるおそれがあります。
 */
function ingestWithRace(store, id, race) {
  const realFstat = fs.fstatSync;
  fs.fstatSync = (...args) => {
    fs.fstatSync = realFstat;
    const st = realFstat(...args);
    race();
    return st;
  };
  try {
    store.ingest(id);
  } finally {
    fs.fstatSync = realFstat;
  }
}

test('ingest はイベントファイルやフォルダが消されても例外を出さず、作り直されたら先頭から読み直す', () => {
  const { store, id, emit } = setup();
  const file = store.eventsFile(id);
  // 作り直したファイルが前回の読み込み位置より短くなるよう、最初の行を長くしておきます。
  // 消した直後に作ったファイルは inode 番号が再利用されることがあり、その場合はサイズで作り直しを判定するためです
  emit({ event: 'SessionStart', session_id: 's1', transcript_path: `/tmp/${'x'.repeat(200)}.jsonl` });

  // 開く前に消されていた場合は、何もせずに戻ります
  fs.rmSync(file);
  assert.doesNotThrow(() => store.ingest(id));
  assert.equal(store.get(id).state, 'idle');

  // 開いた後に消された場合は、消される前の内容を読みます
  fs.appendFileSync(file, JSON.stringify({ ts: 1, event: 'UserPromptSubmit', prompt: '消える前' }) + '\n');
  assert.doesNotThrow(() => ingestWithRace(store, id, () => fs.rmSync(file)));
  assert.equal(store.get(id).state, 'running');
  assert.equal(store.get(id).lastPrompt, '消える前');

  // ファイルが作り直されたら、次の読み込みで先頭から読み直します
  let a = emit({ event: 'Stop' });
  assert.equal(a.state, 'done');

  // フォルダごと消された場合も同じです
  fs.appendFileSync(file, JSON.stringify({ ts: 2, event: 'UserPromptSubmit', prompt: 'フォルダが消える前' }) + '\n');
  assert.doesNotThrow(() => ingestWithRace(store, id, () => fs.rmSync(EVENTS_DIR, { recursive: true })));
  assert.equal(store.get(id).lastPrompt, 'フォルダが消える前');
  assert.doesNotThrow(() => store.ingest(id));
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
  a = emit({ event: 'Stop' });
  assert.equal(a.state, 'done');
});

test('ingest は調べた後にファイルが短く切り詰められても、実際に読めた分だけ読み進める', () => {
  const { store, id } = setup();
  const file = store.eventsFile(id);
  const line = (ev) => JSON.stringify({ ts: 1, ...ev }) + '\n';
  fs.appendFileSync(file, line({ event: 'SessionStart', session_id: 's1' }) + line({ event: 'UserPromptSubmit', prompt: '古いファイル' }));
  // writeFileSync は既存のファイルを同じ inode のまま切り詰めて書き直します
  ingestWithRace(store, id, () => fs.writeFileSync(file, line({ event: 'SessionStart', session_id: 's2' })));
  assert.equal(store.get(id).sessionId, 's2');
  assert.equal(store.get(id).state, 'idle');

  // 書き直したファイルの続きを、読み飛ばさずに取り込むこと
  fs.appendFileSync(file, line({ event: 'UserPromptSubmit', prompt: '新しいファイル' }));
  store.ingest(id);
  assert.equal(store.get(id).state, 'running');
  assert.equal(store.get(id).lastPrompt, '新しいファイル');
});

test('ingest は作り直されたイベントファイルを、前回の読み込み位置より長くても先頭から読み直す', () => {
  const { store, id } = setup();
  const file = store.eventsFile(id);
  const line = (ev) => JSON.stringify({ ts: 1, ...ev }) + '\n';
  fs.appendFileSync(file, line({ event: 'SessionStart', session_id: 's1' }));
  store.ingest(id);
  assert.equal(store.get(id).sessionId, 's1');

  // 別のファイルに書いてから置き換えると、必ず別の inode になります。サイズは前回の読み込み位置より長くしておきます
  const tmp = file + '.new';
  fs.writeFileSync(tmp, line({ event: 'SessionStart', session_id: 's2' }) + line({ event: 'UserPromptSubmit', prompt: '作り直したファイル' }));
  assert.ok(fs.statSync(tmp).size > fs.statSync(file).size);
  fs.renameSync(tmp, file);
  store.ingest(id);
  assert.equal(store.get(id).sessionId, 's2');
  assert.equal(store.get(id).state, 'running');
  assert.equal(store.get(id).lastPrompt, '作り直したファイル');
});

test('init は agents.json とイベントファイルから状態を復元する', () => {
  const { id, emit } = setup();
  emit({ event: 'SessionStart', session_id: 'restored' }, { event: 'UserPromptSubmit', prompt: '復元' }, { event: 'Stop' });
  const store = new Store();
  store.init();
  const a = store.get(id);
  assert.equal(a.state, 'done');
  assert.equal(a.sessionId, 'restored');
  assert.equal(a.lastPrompt, '復元');
});

test('引き継ぎの段階は agents.json に保存し、再起動後は復元した状態から続きを判定できる', async () => {
  const { handoffStep } = await import('../lib/handoff.js');
  const { store, id, emit } = setup();
  emit({ event: 'SessionStart', session_id: 'old' }, { event: 'Stop' });
  const handoff = { stage: 'clear', marker: 'm', fromSession: 'old', sentAt: 1, clearSentAt: Date.now(), memoFile: '/m.md', prevPaused: false, prevNote: '' };
  store.patch(id, { handoff });
  // /clear の後のイベントです。SessionEnd（clear）に続いて新しいセッションの SessionStart が届きます
  emit({ event: 'SessionEnd', reason: 'clear' }, { event: 'SessionStart', source: 'clear', session_id: 'new' });
  const restored = new Store();
  restored.init();
  const a = restored.get(id);
  assert.deepEqual(a.handoff, handoff);
  assert.equal(a.sessionId, 'new');
  assert.equal(a.state, 'idle');
  assert.equal(handoffStep(a).type, 'resume');
});

test('publicAgent は対話要求の内部情報をクライアントに渡さない', () => {
  const { store, id, emit } = setup();
  writeRequest('r-pub', { tool_name: 'Write', tool_input: { file_path: 'x' }, input_hash: 'hh' });
  emit({ event: 'PermissionRequest', tool: 'Write', input_hash: 'hh', reqId: 'r-pub' });
  const pub = publicAgent(store.get(id));
  // subagentId は一覧でサブエージェントを「要対応」にするために渡します（hook の PID や入力のハッシュは渡しません）
  assert.deepEqual(Object.keys(pub.pending[0]).sort(), ['createdAt', 'kind', 'label', 'reqId', 'subagentId', 'tool']);
});

test('サブエージェントからの対話要求はサブエージェントの ID を覚え、サブエージェントのイベントで transcript の場所を変えない', () => {
  const { emit } = setup();
  emit({ event: 'SessionStart', session_id: 's1', transcript_path: '/tmp/parent.jsonl' });
  writeRequest('r-sub', { tool_name: 'Bash', tool_input: { command: 'date' }, input_hash: 'hs' });
  const a = emit(
    { event: 'SubagentStart', agent_id: 'as1', agent_type: 'general-purpose', transcript_path: '/tmp/other.jsonl' },
    { event: 'PermissionRequest', tool: 'Bash', input_hash: 'hs', reqId: 'r-sub', agent_id: 'as1' },
  );
  assert.equal(a.transcriptPath, '/tmp/parent.jsonl');
  assert.equal(a.pending[0].subagentId, 'as1');
  assert.equal(publicAgent(a).pending[0].subagentId, 'as1');
  assert.deepEqual(a.subagents, []);
});

test('親のプロセスの起動時刻は startup / resume の SessionStart で更新し、compact / clear では変えない', () => {
  const { emit } = setup();
  let a = emit({ event: 'SessionStart', source: 'startup', ts: 1000 });
  assert.equal(a.processStartedAt, 1000);
  a = emit({ event: 'SessionStart', source: 'compact', ts: 2000 }, { event: 'SessionStart', source: 'clear', ts: 3000 });
  assert.equal(a.processStartedAt, 1000);
  a = emit({ event: 'SessionStart', source: 'resume', ts: 4000 });
  assert.equal(a.processStartedAt, 4000);
  // サブエージェントのイベントでは変えません
  a = emit({ event: 'SessionStart', source: 'startup', ts: 5000, agent_id: 'as1' });
  assert.equal(a.processStartedAt, 4000);
});
