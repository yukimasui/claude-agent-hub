// 「引き継いでリセット」とコンテキスト量の表示のテストです。
// 段階の進め方（lib/handoff.js の handoffStep）、メモの取り出しと保存形式、画面とサーバで共通の判定（public/handoff.js）、
// transcript からのコンテキスト量の算出（lib/transcript.js）、引き継ぎ中の送信ガードとキュー操作（lib/queue.js）を確かめます。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// lib/config.js は import 時に環境変数を読むため、本番のデータ置き場に触れないよう先に一時ディレクトリを設定します
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-handoff-test-'));
process.env.AGENT_HUB_HOME = home;
delete process.env.HUB_CONTEXT_WARN_TOKENS;
const { CONTEXT_WARN_TOKENS, HANDOFFS_DIR, contextWarnTokens } = await import('../lib/config.js');
const {
  CLEAR_TIMEOUT_MS, MEMO_GRACE_MS, MEMO_TIMEOUT_MS,
  buildMemoPrompt, buildResumePrompt, extractMemo, formatMemoFile, handoffBlock, handoffStep, memoFileName, parseMemoFile, queueRestoreFields,
} = await import('../lib/handoff.js');
const { HANDOFF_PAUSE_NOTE, INTERRUPT_PAUSE_NOTE, MANUAL_PAUSE_NOTE, applyQueueOp, sendBlockReason } = await import('../lib/queue.js');
const { contextTokensOf, readContextTokens } = await import('../lib/transcript.js');
const { contextOver, contextTitle, formatContext, handoffBlockReason, handoffStageLabel, isHandoffActive } = await import('../public/handoff.js');

after(() => fs.rmSync(home, { recursive: true, force: true }));

const T0 = 1_700_000_000_000;
const MARKER = 'handoff-abcd1234';

/** 引き継ぎを始めた直後のエージェントを基本に、指定したフィールドだけを変えたものを作ります */
function agent(fields = {}, handoff = {}) {
  return {
    id: 'a1', alive: true, pending: [], state: 'running', stateSince: T0 + 10, sessionId: 's1', transcriptPath: '/tmp/t.jsonl',
    queue: [], queuePaused: true, queueNote: HANDOFF_PAUSE_NOTE,
    handoff: { stage: 'memo', marker: MARKER, fromSession: 's1', startedAt: T0, sentAt: T0, prevPaused: false, prevNote: '', ...handoff },
    ...fields,
  };
}

const items = (...xs) => xs.map(([role, text]) => ({ role, text }));
const memoReply = 'まとめます。\n\n```handoff\n## 進行中の作業\n- Issue #1 の実装\n```\n';
const answered = items(['user', '最初の指示'], ['assistant', '作業しました'], ['user', buildMemoPrompt(MARKER)], ['assistant', memoReply]);

// ---------- 設定 ----------

test('コンテキスト量の目安は既定で 150,000 で、正の数として読めない値は既定値にする', () => {
  assert.equal(CONTEXT_WARN_TOKENS, 150000);
  assert.equal(contextWarnTokens('80000'), 80000);
  assert.equal(contextWarnTokens('1000.7'), 1000);
  for (const v of [undefined, '', '0', '-5', 'abc']) assert.equal(contextWarnTokens(v), 150000, String(v));
});

test('メモの保存先はデータ置き場の handoffs/ にある', () => {
  assert.equal(HANDOFFS_DIR, path.join(home, 'handoffs'));
});

// ---------- メモの取り出し ----------

test('handoff ブロックの中身を取り出し、メモの中のコードブロックで途中で切らない', () => {
  assert.equal(handoffBlock(memoReply), '## 進行中の作業\n- Issue #1 の実装');
  const nested = '```handoff\n手順:\n```bash\nnpm test\n```\n続き\n```\n';
  assert.equal(handoffBlock(nested), '手順:\n```bash\nnpm test\n```\n続き');
  // 閉じていないブロック（応答が途中で終わった場合など）は終わりまでをメモにします
  assert.equal(handoffBlock('```handoff\n途中まで'), '途中まで');
  assert.equal(handoffBlock('ブロックなし'), null);
  assert.equal(handoffBlock(null), null);
});

test('指示より後の応答からメモを取り出す', () => {
  assert.equal(extractMemo(answered, MARKER), '## 進行中の作業\n- Issue #1 の実装');
});

test('ブロックがない応答は、指示より後の応答の本文をすべてメモにする', () => {
  const xs = items(['user', `x ${MARKER}`], ['assistant', '前半'], ['tool', ''], ['assistant', '後半']);
  assert.equal(extractMemo(xs, MARKER), '前半\n\n後半');
});

test('指示より前の応答や、指示が見つからない会話からはメモを取り出さない', () => {
  // 前の会話に handoff ブロックがあっても、今回の指示への応答ではないので使いません
  const xs = items(['assistant', memoReply], ['user', `x ${MARKER}`]);
  assert.equal(extractMemo(xs, MARKER), null);
  assert.equal(extractMemo(items(['user', 'ほかの指示'], ['assistant', memoReply]), MARKER), null);
  assert.equal(extractMemo(items(['user', `x ${MARKER}`], ['assistant', '   ']), MARKER), null);
  assert.equal(extractMemo(answered, ''), null);
});

test('同じ識別子の指示が複数あるときは、最後の指示への応答を使う', () => {
  const xs = items(['user', `1 ${MARKER}`], ['assistant', '```handoff\n古い\n```'], ['user', `2 ${MARKER}`], ['assistant', '```handoff\n新しい\n```']);
  assert.equal(extractMemo(xs, MARKER), '新しい');
});

test('メモの指示は識別子を含み、ファイルに書かずにブロックで書くよう求める', () => {
  const p = buildMemoPrompt(MARKER);
  assert.ok(p.includes(MARKER));
  assert.match(p, /```handoff/);
  assert.match(p, /ファイルには書かないでください/);
  for (const k of ['進行中の作業', '決定事項', '未解決の点', '次にやること', 'Issue']) assert.ok(p.includes(k), k);
});

test('再開の指示は引き継ぎであることとメモの保存先を伝え、メモを含む', () => {
  const p = buildResumePrompt('メモ本文', '/x/handoffs/a1.md');
  assert.match(p, /^前のセッションからの引き継ぎです。/);
  assert.match(p, /続きから作業を再開してください/);
  assert.ok(p.includes('/x/handoffs/a1.md'));
  assert.ok(p.endsWith('メモ本文'));
});

test('保存したメモファイルから本文を読み戻せる', () => {
  const meta = { id: 'a1', name: 'w--x-->', cwd: '/w', sessionId: 's1', createdAt: T0 };
  const text = formatMemoFile(meta, '## メモ\n- 1');
  assert.match(text, /^<!-- Agent Hub 引き継ぎメモ: /);
  // 名前に含まれる --> でコメントが途中で閉じないようにしています
  assert.equal(text.split('-->').length, 2);
  assert.equal(parseMemoFile(text), '## メモ\n- 1');
  assert.equal(memoFileName('a1', T0), 'a1-20231114-221320.md');
});

// ---------- 段階の進行 ----------

test('引き継ぎがないか、完了・中止の結果だけのときは何もしない', () => {
  assert.equal(handoffStep(agent({ handoff: null })).type, 'none');
  assert.equal(handoffStep(agent({}, { stage: 'done' })).type, 'none');
  assert.equal(handoffStep(agent({}, { stage: 'failed' })).type, 'none');
});

test('メモの段階: 応答が終わるまで待ち、終わったらメモを付けて /clear に進む', () => {
  const read = () => answered;
  assert.equal(handoffStep(agent(), { now: T0 + 1000, readItems: read }).type, 'wait');
  // 指示を送る前の「応答完了」は今回の応答ではありません
  assert.equal(handoffStep(agent({ state: 'done', stateSince: T0 - 1 }), { now: T0 + 1000, readItems: read }).type, 'wait');
  const step = handoffStep(agent({ state: 'done', stateSince: T0 + 500 }), { now: T0 + 1000, readItems: read });
  assert.deepEqual(step, { type: 'clear', memo: '## 進行中の作業\n- Issue #1 の実装' });
});

test('メモの段階: メモを取り出せなければ少し待ってから /clear せずに中止する', () => {
  const empty = () => items(['user', buildMemoPrompt(MARKER)]);
  const a = agent({ state: 'done', stateSince: T0 + 500 });
  assert.equal(handoffStep(a, { now: T0 + 500 + MEMO_GRACE_MS - 1, readItems: empty }).type, 'wait');
  const step = handoffStep(a, { now: T0 + 500 + MEMO_GRACE_MS + 1, readItems: empty });
  assert.equal(step.type, 'fail');
  assert.match(step.reason, /取り出せなかった/);
  assert.match(step.reason, /\/clear は送っていません/);
});

test('メモの段階: 要対応・中断・終了・セッションの切り替わり・時間切れでは /clear せずに中止する', () => {
  const cases = [
    [{ pending: [{ reqId: 'r1' }] }, /回答待ち/],
    [{ state: 'waiting', stateSince: T0 + 5 }, /回答待ち/],
    [{ state: 'idle', stateSince: T0 + 5 }, /中断/],
    [{ state: 'ended', stateSince: T0 + 5 }, /終了/],
    [{ alive: false }, /終了/],
    [{ sessionId: 's2' }, /セッションが切り替わった/],
  ];
  for (const [fields, re] of cases) {
    const step = handoffStep(agent(fields), { now: T0 + 1000, readItems: () => answered });
    assert.equal(step.type, 'fail', JSON.stringify(fields));
    assert.match(step.reason, re);
    assert.match(step.reason, /\/clear は送っていません/);
  }
  const late = handoffStep(agent(), { now: T0 + MEMO_TIMEOUT_MS + 1 });
  assert.equal(late.type, 'fail');
  assert.match(late.reason, /終わらなかった/);
});

test('メモの段階: 始める前から「待機中」だった場合は中断とみなさない', () => {
  assert.equal(handoffStep(agent({ state: 'idle', stateSince: T0 - 100 }), { now: T0 + 10 }).type, 'wait');
});

test('/clear の段階: 新しいセッションが「待機中」になったら再開の指示を送る', () => {
  const h = { stage: 'clear', memoFile: '/m.md', clearSentAt: T0 + 2000 };
  assert.equal(handoffStep(agent({ state: 'done' }, h), { now: T0 + 3000 }).type, 'wait');
  // /clear では SessionEnd に続いて SessionStart が届くため、途中の「終了」では中止しません
  assert.equal(handoffStep(agent({ state: 'ended', sessionId: 's2' }, h), { now: T0 + 3000 }).type, 'wait');
  assert.equal(handoffStep(agent({ state: 'idle', sessionId: 's2' }, h), { now: T0 + 3000 }).type, 'resume');
});

test('/clear の段階: 新しいセッションで指示がすでに始まっていれば、二重に送らず完了にする', () => {
  const h = { stage: 'clear', memoFile: '/m.md', clearSentAt: T0 + 2000 };
  const step = handoffStep(agent({ state: 'running', sessionId: 's2' }, h), { now: T0 + 3000 });
  assert.equal(step.type, 'finish');
  assert.ok(step.note.includes('/m.md'));
});

test('/clear の段階: 新しいセッションを確認できないまま時間が過ぎたら、メモの保存先を添えて中止する', () => {
  const h = { stage: 'clear', memoFile: '/m.md', clearSentAt: T0 + 2000 };
  assert.equal(handoffStep(agent({ state: 'done' }, h), { now: T0 + 2000 + CLEAR_TIMEOUT_MS - 1 }).type, 'wait');
  const step = handoffStep(agent({ state: 'done' }, h), { now: T0 + 2000 + CLEAR_TIMEOUT_MS + 1 });
  assert.equal(step.type, 'fail');
  assert.ok(step.reason.includes('/m.md'));
  const dead = handoffStep(agent({ alive: false }, h), { now: T0 + 3000 });
  assert.equal(dead.type, 'fail');
  assert.ok(dead.reason.includes('/m.md'));
});

test('サーバの再起動後に保存した段階から判定し直しても、メモを取り出せる前に /clear へ進まない', () => {
  // 再起動後は、イベント JSONL から復元した状態と保存した handoff だけで判定します。
  // 指示を送る前に止まった（UserPromptSubmit が記録されていない）場合は「応答完了」のまま時刻が古いので、待った後に中止になります
  const before = agent({ state: 'done', stateSince: T0 - 100 });
  assert.equal(handoffStep(before, { now: T0 + 1000, readItems: () => answered }).type, 'wait');
  assert.equal(handoffStep(before, { now: T0 + MEMO_TIMEOUT_MS + 1, readItems: () => answered }).type, 'fail');
});

// ---------- キューの扱い ----------

test('終了時は引き継ぎ前のキューの一時停止の状態に戻す', () => {
  assert.deepEqual(queueRestoreFields(agent()), { queuePaused: false, queueNote: '' });
  assert.deepEqual(queueRestoreFields(agent({}, { prevPaused: true, prevNote: MANUAL_PAUSE_NOTE })), { queuePaused: true, queueNote: MANUAL_PAUSE_NOTE });
});

test('引き継ぎの間に別の理由で一時停止し直した場合は、その理由を残す', () => {
  assert.deepEqual(queueRestoreFields(agent({ queueNote: INTERRUPT_PAUSE_NOTE })), {});
});

test('引き継ぎの間は入力欄からの送信を拒否し、キューの一時停止・再開・送信も受け付けない', () => {
  const a = agent({ state: 'done', queue: [{ id: 'q1', text: 'x', clearFirst: false, createdAt: 1 }] });
  assert.match(sendBlockReason(a), /引き継いでリセット/);
  for (const op of ['pause', 'resume', 'sendNext']) {
    assert.throws(() => applyQueueOp(a, { op }), (e) => e.status === 409 && /引き継いでリセット/.test(e.message), op);
  }
  // 項目の追加や編集はできます（終了後に元の状態で送られます）
  const { fields } = applyQueueOp(a, { op: 'add', text: '次の作業' });
  assert.equal(fields.queue.length, 2);
  assert.equal(fields.queuePaused, undefined);
  // 結果を表示しているだけのときは通常どおりです
  assert.equal(sendBlockReason(agent({ state: 'done' }, { stage: 'done' })), null);
});

// ---------- 画面とサーバで共通の判定 ----------

test('「応答完了」か「待機中」で回答待ちがなく、会話があるときだけ始められる', () => {
  const ok = { alive: true, pending: [], state: 'done', transcriptPath: '/t.jsonl', handoff: null };
  assert.equal(handoffBlockReason(ok), null);
  assert.equal(handoffBlockReason({ ...ok, state: 'idle' }), null);
  assert.equal(handoffBlockReason({ ...ok, handoff: { stage: 'failed' } }), null);
  for (const state of ['running', 'waiting', 'starting', 'compacting', 'ended']) assert.ok(handoffBlockReason({ ...ok, state }), state);
  assert.match(handoffBlockReason({ ...ok, pending: [{ reqId: 'r' }] }), /回答待ち/);
  assert.match(handoffBlockReason({ ...ok, alive: false }), /停止/);
  assert.match(handoffBlockReason({ ...ok, transcriptPath: null }), /会話がありません/);
  assert.match(handoffBlockReason({ ...ok, handoff: { stage: 'memo' } }), /実行中/);
  assert.ok(handoffBlockReason(null));
});

test('段階の表示と、進行中かどうかの判定', () => {
  assert.equal(isHandoffActive({ stage: 'memo' }), true);
  assert.equal(isHandoffActive({ stage: 'clear' }), true);
  assert.equal(isHandoffActive({ stage: 'done' }), false);
  assert.equal(isHandoffActive(null), false);
  assert.match(handoffStageLabel({ stage: 'memo' }), /^1\/3/);
  assert.match(handoffStageLabel({ stage: 'clear' }), /^2\/3/);
  assert.match(handoffStageLabel({ stage: 'failed' }), /中止/);
  assert.equal(handoffStageLabel(null), '');
});

test('コンテキスト量を短く表記し、目安を超えたら目印の対象にする', () => {
  assert.equal(formatContext(8500), 'ctx 8,500');
  assert.equal(formatContext(123456), 'ctx 12.3万');
  assert.equal(formatContext(1234567), 'ctx 123万');
  assert.equal(formatContext(null), '');
  assert.equal(formatContext(0), '');
  assert.equal(contextOver(150001, 150000), true);
  assert.equal(contextOver(150000, 150000), false);
  assert.equal(contextOver(null, 150000), false);
  assert.equal(contextOver(200000, undefined), false);
  assert.match(contextTitle(200000, 150000), /超えています/);
  assert.match(contextTitle(1000, 150000), /目安は 150,000/);
});

// ---------- コンテキスト量の算出 ----------

const usageLine = (u, extra = {}) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [], usage: u }, ...extra }) + '\n';

test('最新の応答の入力の量を合計してコンテキスト量にする', () => {
  assert.equal(contextTokensOf(JSON.parse(usageLine({ input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 50 }))), 2105);
  // サブエージェントのやり取り、使用量のない行、合成の応答（使用量がすべて 0）は使いません
  assert.equal(contextTokensOf(JSON.parse(usageLine({ input_tokens: 9 }, { isSidechain: true }))), null);
  assert.equal(contextTokensOf({ type: 'user', message: { usage: { input_tokens: 9 } } }), null);
  assert.equal(contextTokensOf(JSON.parse(usageLine({ input_tokens: 0, output_tokens: 0 }))), null);
  assert.equal(contextTokensOf({ type: 'assistant', message: {} }), null);
});

test('transcript の追記分だけを読んで最新のコンテキスト量を返す', () => {
  const file = path.join(home, 'ctx.jsonl');
  assert.equal(readContextTokens(file), null); // まだファイルがありません
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n');
  assert.equal(readContextTokens(file), null);
  fs.appendFileSync(file, usageLine({ input_tokens: 10, cache_read_input_tokens: 1000 }));
  assert.equal(readContextTokens(file), 1010);
  fs.appendFileSync(file, usageLine({ input_tokens: 99999 }, { isSidechain: true }));
  assert.equal(readContextTokens(file), 1010);
  // 書きかけの行は、改行が書かれてから読みます
  const line = usageLine({ input_tokens: 3000 });
  fs.appendFileSync(file, line.slice(0, 20));
  assert.equal(readContextTokens(file), 1010);
  fs.appendFileSync(file, line.slice(20));
  assert.equal(readContextTokens(file), 3000);
  // 作り直された（短くなった）ファイルは最初から読み直します
  fs.writeFileSync(file, usageLine({ input_tokens: 7 }));
  assert.equal(readContextTokens(file), 7);
  assert.equal(readContextTokens(null), null);
});
