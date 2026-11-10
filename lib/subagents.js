// サブエージェント（Agent ツールで起動されたエージェント）の一覧と状態を組み立てます。
// Claude Code は、親のセッションの transcript と同じ場所の <セッション ID>/subagents/ に、
// サブエージェントごとの transcript（agent-<ID>.jsonl）と起動時の情報（agent-<ID>.meta.json）を記録します。
// hook のイベントには説明（description）や親子関係が含まれないため、状態の正本はこれらのファイルとし、
// hook のイベントは画面を更新するきっかけと、回答待ちの要求がどのサブエージェントのものかの判別にだけ使います。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import { readTranscript } from './transcript.js';

const { summarize, shorten } = createRequire(import.meta.url)('../hooks/summarize.cjs');

// サブエージェント ID の形式です（実際は "a" と 16 桁の 16 進数）。
// ID からファイル名を組み立てるため、区切り文字やドットを含むものは受け付けず、subagents/ の外を指せないようにしています
export const SUBAGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_RE = /^agent-([A-Za-z0-9_-]{1,64})\.meta\.json$/;

// サブエージェントの作業中に、親のターンが続いているとみなす状態です（フォアグラウンドのサブエージェントの判定に使います）
const PARENT_BUSY = new Set(['running', 'waiting', 'compacting']);

// 末尾を読む量です。最後の行が長い（大きなツールの結果など）場合に備えて、見つからなければ広げて読み直します
const TAIL_STEPS = [64 * 1024, 1024 * 1024];
const HEAD_BYTES = 64 * 1024;

// 完了の記録（meta.json の更新）より後に transcript がこれ以上更新されていれば、再開されたとみなします。
// 実際の記録では、完了時の meta.json と transcript の更新時刻の差は 1 秒以内でした
const RESUME_GAP_MS = 5000;

// 完了通知を探すために親の transcript を読む量の上限（1 回の確認あたり）と、1 回に読み込む大きさです。
// 大きな transcript を一度に読むとサーバの応答が止まるため、少しずつ読み進め、残りは次の確認で読みます
const NOTIFY_READ_LIMIT = 2 * 1024 * 1024;
const NOTIFY_CHUNK = 256 * 1024;

/**
 * 上限付きのキャッシュです。上限を超えたら、最も長く使われていないものから削除します。
 * ハブは長く動かし続けるため、サブエージェントや親のセッションの数に比例してキャッシュが増え続けないようにしています。
 */
class LruCache {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const v = this.map.get(key);
    if (v !== undefined) {
      // Map は挿入順を保つので、入れ直して「最近使った」側へ移します
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

const metaCache = new LruCache(2000); // meta.json のパス -> { size, mtimeMs, meta }
const tailCache = new LruCache(2000); // transcript のパス -> { size, mtimeMs, tail }
const startCache = new LruCache(2000); // transcript のパス -> 開始時刻
const notifyCache = new LruCache(200); // 親の transcript のパス -> { offset, decoder, rest, statuses }

/** 親の transcript のパスから、サブエージェントの記録の置き場を返します（形式が違えば null） */
export function subagentsDir(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return null;
  return path.join(transcriptPath.slice(0, -'.jsonl'.length), 'subagents');
}

function statFile(file) {
  try {
    const st = fs.lstatSync(file);
    // シンボリックリンクはたどらず、通常のファイルだけを扱います（subagents/ の外のファイルを読まないため）
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function readRange(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** meta.json を読み、{ meta, mtimeMs } を返します（読めなければ null） */
function readMeta(file) {
  const st = statFile(file);
  if (!st) return null;
  const hit = metaCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.meta ? hit : null;
  let meta = null;
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (o && typeof o === 'object') meta = o;
  } catch {
    // 書き込み途中などで読めない場合は、前回の内容を使い、次の確認で読み直します
    return hit?.meta ? hit : null;
  }
  const entry = { size: st.size, mtimeMs: st.mtimeMs, meta };
  metaCache.set(file, entry);
  return meta ? entry : null;
}

/** transcript の先頭の行から開始時刻を取ります。先頭の行は変わらないので一度だけ読みます */
function readStart(file, st) {
  const hit = startCache.get(file);
  if (hit !== undefined) return hit;
  let ts = null;
  try {
    const head = readRange(file, 0, Math.min(st.size, HEAD_BYTES)).toString('utf8');
    // JSON の文字列の中の引用符はエスケープされるため、この並びは行の項目としての timestamp にだけ一致します
    const m = head.match(/"timestamp":"([^"]+)"/);
    ts = m ? Date.parse(m[1]) || null : null;
  } catch {}
  if (ts == null) ts = st.birthtimeMs || st.mtimeMs;
  if (st.size) startCache.set(file, ts);
  return ts;
}

/**
 * transcript の最後のやり取りから、作業中の内容を表す文字列と時刻を返します。
 * 最後がツールの呼び出しならそのツール（親エージェントの表示と同じ「ツール名: 要約」）、それ以外は考え中とみなします。
 */
export function tailActivity(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!o?.message || (o.type !== 'assistant' && o.type !== 'user')) continue;
    const ts = Date.parse(o.timestamp) || null;
    const c = o.message.content;
    const last = o.type === 'assistant' && Array.isArray(c) ? c[c.length - 1] : null;
    if (last?.type === 'tool_use') {
      const s = summarize(last.name, last.input);
      return { activity: `${last.name}${s ? ': ' + s : ''}`, ts };
    }
    return { activity: '思考中…', ts };
  }
  return null;
}

function readTail(file, st) {
  const hit = tailCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.tail;
  let tail = null;
  try {
    for (const n of TAIL_STEPS) {
      const start = Math.max(0, st.size - n);
      const lines = readRange(file, start, st.size - start).toString('utf8').split('\n');
      // 途中から読んだ場合、最初の行は欠けているので使いません
      if (start > 0) lines.shift();
      tail = tailActivity(lines);
      if (tail || start === 0) break;
    }
  } catch {}
  tailCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, tail });
  return tail;
}

/**
 * 親の transcript にあるタスクの完了通知（<task-notification>）から、タスク ID ごとの最終状態を読み取ります。
 * サブエージェントが失敗・停止した場合は meta.json に記録が残らないことがあるため、通知の status を併せて使います。
 * 親の transcript は大きくなるので、前回の続きから追記分だけを、1 回の確認あたり limit バイトまで読みます。
 * 読み終えていない部分は次の確認で読みます（読み終えたかは notificationsCaughtUp で分かります）。
 */
export function readNotifications(transcriptPath, { limit = NOTIFY_READ_LIMIT } = {}) {
  const st = transcriptPath ? statFile(transcriptPath) : null;
  if (!st) return new Map();
  let cur = notifyCache.get(transcriptPath);
  if (!cur || st.size < cur.offset) {
    cur = { offset: 0, size: 0, decoder: new StringDecoder('utf8'), rest: '', statuses: new Map() };
    notifyCache.set(transcriptPath, cur);
  }
  cur.size = st.size;
  const end = Math.min(st.size, cur.offset + limit);
  while (cur.offset < end) {
    let buf;
    try {
      buf = readRange(transcriptPath, cur.offset, Math.min(NOTIFY_CHUNK, end - cur.offset));
    } catch {
      break;
    }
    if (!buf.length) break;
    cur.offset += buf.length;
    const lines = (cur.rest + cur.decoder.write(buf)).split('\n');
    cur.rest = lines.pop();
    for (const line of lines) {
      if (!line.includes('<task-notification>')) continue;
      // 行は JSON のままなので改行は \n の 2 文字になっています。通知 1 件の範囲に収まるよう距離を制限して対応付けます
      for (const m of line.matchAll(/<task-id>([\w-]{1,64})<\/task-id>.{0,1500}?<status>(\w{1,32})<\/status>/g)) cur.statuses.set(m[1], m[2]);
    }
  }
  return cur.statuses;
}

/** 親の transcript の完了通知を最後まで読み終えているかを返します */
export function notificationsCaughtUp(transcriptPath) {
  const cur = transcriptPath ? notifyCache.get(transcriptPath) : null;
  return !!cur && cur.offset >= cur.size;
}

/**
 * 1 件のサブエージェントの状態を決めます（ファイルを読まない純粋な関数です）。
 * - waiting: そのサブエージェントからの対話要求が回答待ち
 * - done / failed: meta.json の finished、または親への完了通知の status
 * - ended: 終了の記録がないまま親のプロセスが終わった、親のプロセスが今のプロセスとして起動する前に記録が止まっている
 *   （または、フォアグラウンドなのに親のターンが終わった）
 * - running: 上記以外
 * lastUpdate はサブエージェントの記録の最後の更新時刻、resumed は完了の記録の後も記録が続いている（再開された）かです。
 */
export function subagentState({ meta, notified, parent, waiting, lastUpdate, resumed = false }) {
  // 再開されたものは、以前の完了の記録や通知ではなく、今の記録の続き方で判定します
  if (!resumed) {
    if (notified === 'failed') return 'failed';
    if (notified === 'killed') return 'ended';
    if (meta?.finished || notified === 'completed') return 'done';
  }
  if (!parent || !parent.alive || parent.state === 'ended') return 'ended';
  // 親を再起動（--resume）すると同じ subagents/ を読み直すため、前のプロセスとともに止まったものが実行中に戻らないようにします
  if (parent.processStartedAt && lastUpdate != null && lastUpdate < parent.processStartedAt) return 'ended';
  if (waiting) return 'waiting';
  // フォアグラウンドのサブエージェントは親のターンの中でしか動かないため、親のターンが終わっていれば中断されたとみなします
  if (meta?.requestShape !== 'background' && !PARENT_BUSY.has(parent.state)) return 'ended';
  return 'running';
}

const ACTIVITY = { done: '完了しました', failed: '失敗しました', ended: '中断しました' };

/**
 * 親エージェントのサブエージェントを、開始時刻の古い順に返します。
 * parent はハブのエージェント（transcriptPath・alive・state・pending・processStartedAt を使います）です。
 */
export function listSubagents(parent) {
  const dir = subagentsDir(parent?.transcriptPath);
  if (!dir) return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const notified = readNotifications(parent.transcriptPath);
  const pendingBySub = new Map();
  for (const p of parent.pending || []) if (p.subagentId && !pendingBySub.has(p.subagentId)) pendingBySub.set(p.subagentId, p);

  const list = [];
  for (const name of names) {
    const id = name.match(FILE_RE)?.[1];
    if (!id) continue;
    const entry = readMeta(path.join(dir, name));
    if (!entry) continue;
    const { meta } = entry;
    const file = path.join(dir, `agent-${id}.jsonl`);
    const st = statFile(file);
    const tail = st ? readTail(file, st) : null;
    const pending = pendingBySub.get(id);
    const updatedAt = st ? st.mtimeMs : null;
    const state = subagentState({
      meta,
      notified: notified.get(id),
      parent,
      waiting: !!pending,
      lastUpdate: Math.max(updatedAt ?? 0, entry.mtimeMs),
      resumed: !!meta.finished && updatedAt != null && updatedAt > entry.mtimeMs + RESUME_GAP_MS,
    });
    const parentId = typeof meta.parentAgentId === 'string' && SUBAGENT_ID_RE.test(meta.parentAgentId) ? meta.parentAgentId : null;
    list.push({
      id,
      parentId,
      description: shorten(String(meta.description || meta.agentType || id), 120),
      agentType: typeof meta.agentType === 'string' ? meta.agentType : '',
      background: meta.requestShape === 'background',
      state,
      activity: state === 'waiting' ? pending.label : state === 'running' ? tail?.activity || '処理中…' : ACTIVITY[state],
      startedAt: st ? readStart(file, st) : null,
      // 猫の表示（完了直後の喜び・しばらくして昼寝）は、状態が変わった時刻として最後の記録の時刻を使います
      stateSince: state === 'running' ? tail?.ts || updatedAt : updatedAt,
      updatedAt,
    });
  }
  return list.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || (a.id < b.id ? -1 : 1));
}

/**
 * サブエージェントの会話を、親と同じ表示用の項目にして返します（見つからなければ null）。
 * 読むのは親のセッションの subagents/ にあり、meta.json の記録があるサブエージェントの transcript だけです。
 * 画像の参照は親の transcript にしか対応していないため、サブエージェントの会話からは除きます。
 */
export function readSubagentTranscript(parent, subId, limit = 300) {
  const dir = subagentsDir(parent?.transcriptPath);
  if (!dir || typeof subId !== 'string' || !SUBAGENT_ID_RE.test(subId)) return null;
  if (!readMeta(path.join(dir, `agent-${subId}.meta.json`))) return null;
  const file = path.join(dir, `agent-${subId}.jsonl`);
  if (path.dirname(file) !== dir || !statFile(file)) return null;
  return readTranscript(file, limit, { sidechain: true })
    .map(({ images, ...it }) => it)
    .filter((it) => !(it.role === 'user' && !it.text));
}
