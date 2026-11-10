// Claude Code の transcript JSONL を会話表示用に整形するにゃ
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { summarize } = createRequire(import.meta.url)('../hooks/summarize.cjs');

const cache = new Map(); // path -> { size, mtimeMs, items, images }

// 画面に返す画像の MIME タイプです。SVG は同じオリジンでスクリプトを実行できるおそれがあるため含めません
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// 参照に使う ID（ツール呼び出し ID や行の uuid）の形式です。URL のパスにそのまま入れるため、想定外の文字を含むものは扱いません
const SOURCE_ID_RE = /^[\w-]{1,128}$/;

/**
 * 表示してよい形式の画像ブロックかを判定します。
 * base64 以外（URL 参照など）や対応外の MIME タイプは、画像 API で返さないので会話の項目にも載せません。
 */
function isImageBlock(b) {
  return b?.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string' && IMAGE_TYPES.has(b.source.media_type);
}

/**
 * ブロックの配列から画像を探し、会話の項目に載せる参照を作ります。
 * base64 は会話 API の応答を重くするので項目には入れず、transcript 上の位置（行のバイト位置と長さ）だけを images に記録します。
 * 画像本体は、画像 API で要求されたときにその行だけを読み直して取り出します。
 */
function collectImages(blocks, { kind, sourceId, line, images, dims }) {
  if (!Array.isArray(blocks) || !SOURCE_ID_RE.test(sourceId || '')) return [];
  const refs = [];
  // dims は toolUseResult にある 1 枚の画像についての寸法なので、画像が 1 枚だけのときに限って付けます。
  // 複数の画像に同じ寸法を付けると、2 枚目以降の画像の説明（alt・title）に誤った寸法が表示されるためです
  if (blocks.filter((b) => b?.type === 'image').length !== 1) dims = null;
  let index = 0;
  for (const b of blocks) {
    if (b?.type !== 'image') continue;
    const i = index++;
    if (!isImageBlock(b)) continue;
    const ref = `${sourceId}.${i}`;
    images.set(ref, { ...line, kind, sourceId, index: i });
    const r = { ref, mime: b.source.media_type };
    if (dims && Number.isFinite(dims.width) && Number.isFinite(dims.height)) Object.assign(r, dims);
    refs.push(r);
  }
  return refs;
}

/** Read の結果（toolUseResult.file）にある表示用の寸法です。画像 API が返すのはこの寸法の画像です */
function readDims(tur) {
  const d = tur?.file?.dimensions;
  if (!d) return null;
  return { width: d.displayWidth ?? d.originalWidth, height: d.displayHeight ?? d.originalHeight };
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return '';
}

function userItem(text, ts) {
  // ハブから送った長文は Claude Code が貼り付け扱いでタグに包むので、表示では外すにゃ
  const t = text
    .replace(/<pasted_content[^>]*>\n?/g, '')
    .replace(/\n?<\/pasted_content[^>]*>/g, '')
    .trim();
  if (!t || t.startsWith('<system-reminder>')) return null;
  const cmd = t.match(/<command-name>(.*?)<\/command-name>/s);
  if (cmd) {
    const args = t.match(/<command-args>(.*?)<\/command-args>/s)?.[1]?.trim();
    return { role: 'system', text: `${cmd[1].trim()}${args ? ' ' + args : ''}`, ts };
  }
  const out = t.match(/<local-command-std(?:out|err)>(.*?)<\/local-command-std(?:out|err)>/s);
  if (out) return out[1].trim() ? { role: 'system', text: out[1].trim(), ts } : null;
  if (t.startsWith('<local-command-caveat>')) return null;
  if (t.startsWith('[Request interrupted')) return { role: 'system', text: '中断されました', ts };
  return { role: 'user', text: t, ts };
}

/**
 * 通常の user 行として記録されるが、利用者の発言ではない行を表示用の項目にします。該当しない行には null を返します。
 * - 会話の圧縮（compact）で作られた要約（isCompactSummary）: 長い要約が利用者の発言に見えないよう、圧縮の項目にします
 * - ターンの終了後に届いたバックグラウンドのタスクの完了通知: エージェントが自分から作業を始めた理由が分かるよう、
 *   システムの行として要約（<summary>）だけを表示します。行の origin.kind で判定し、origin のない記録に限って本文の先頭のタグで判定します。
 *   利用者が同じタグで始まる文を入力した場合（origin.kind が human）に、完了通知と取り違えないためです
 * ツールの結果を含む行は対象にしません（結果をツール呼び出しの項目に対応付ける処理を飛ばさないためです）。
 */
function nonHumanUserItem(o, ts) {
  const c = o.message.content;
  if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return null;
  const text = blockText(c).trim();
  if (o.isCompactSummary) return { role: 'compact', text, ts };
  const kind = o.origin?.kind;
  if (kind === 'task-notification' || (!kind && text.startsWith('<task-notification>'))) {
    const summary = text.match(/<summary>(.*?)<\/summary>/s)?.[1]?.trim();
    return { role: 'system', text: summary ? `完了通知: ${summary}` : 'バックグラウンドのタスクの完了通知', ts };
  }
  return null;
}

/**
 * 処理中に送られ、ターンの途中で取り込まれた発言（queued_command の attachment 行）を利用者の発言の項目にします。
 * この発言は通常の user 行としては記録されないため、ここで拾わないと会話表示から抜け落ちます。
 * 利用者が入力したもの（origin.kind が human で commandMode が prompt）だけを対象にします。
 * 同じ形の行には、バックグラウンドのタスクの完了通知（task-notification）やサブエージェントからの報告（peer）もあり、
 * これらは利用者の発言ではないためです。
 */
function queuedPromptItem(o) {
  const a = o.attachment;
  if (a?.type !== 'queued_command' || a.origin?.kind !== 'human' || a.commandMode !== 'prompt' || a.isMeta) return null;
  const text = typeof a.prompt === 'string' ? a.prompt : blockText(a.prompt);
  const it = userItem(text, a.timestamp || o.timestamp);
  if (it?.role !== 'user') return it;
  // 画面で「処理中に送った発言」と分かるように目印を付けます
  return { ...it, queued: true };
}

/**
 * 取り込まれた発言の項目を、送信した時刻の位置に入れます。
 * 行が書かれるのは取り込まれた時点（実行中のツールの結果の後）ですが、timestamp は送信した時刻です。
 * 応答の生成中に送った場合は、送信より後に書かれた応答やツール呼び出しの後ろに行が来るため、
 * 末尾から送信時刻より後の項目をさかのぼり、その前に入れます。時刻を比べられない項目があればそこで止めます。
 */
function insertByTime(items, it) {
  const t = Date.parse(it.ts);
  let i = items.length;
  if (Number.isFinite(t)) {
    while (i > 0) {
      const prev = Date.parse(items[i - 1].ts);
      if (!Number.isFinite(prev) || prev <= t) break;
      i--;
    }
  }
  items.splice(i, 0, it);
}

/** ツール呼び出しを表示用アイテムにするにゃ。結果は後から tool_result で埋めるにゃ */
function toolItem(b, ts) {
  const input = b.input || {};
  switch (b.name) {
    case 'AskUserQuestion':
      return { role: 'question', id: b.id, questions: input.questions || [], answers: null, annotations: null, status: 'pending', ts };
    case 'ExitPlanMode':
      return { role: 'plan', id: b.id, plan: input.plan || '', planFilePath: input.planFilePath || null, status: 'pending', ts };
    case 'TodoWrite':
      return { role: 'todos', id: b.id, todos: input.todos || [], ts };
    default:
      return { role: 'tool', id: b.id, name: b.name, summary: summarize(b.name, input), ts };
  }
}

function applyResult(item, b, o, ctx) {
  const text = blockText(b.content);
  const tur = o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult : null;
  if (item.role === 'question') {
    if (b.is_error) {
      item.status = 'rejected';
      item.resultText = text;
    } else {
      item.status = 'answered';
      item.answers = tur?.answers || null;
      item.annotations = tur?.annotations || null;
      if (!item.answers) item.resultText = text;
    }
  } else if (item.role === 'plan') {
    item.status = b.is_error ? 'rejected' : 'approved';
    item.resultText = text;
  } else {
    if (b.is_error) item.error = text.slice(0, 800);
    // 画像を表示するのは通常のツール呼び出しだけにします（質問・計画のカードには画像の表示欄がないため）
    if (item.role === 'tool') {
      const imgs = collectImages(b.content, { ...ctx, kind: 'tool', sourceId: b.tool_use_id });
      if (imgs.length) item.images = imgs;
    }
  }
}

function parse(buf) {
  const items = [];
  const byId = new Map();
  const images = new Map(); // 画像の参照 -> transcript 上の位置
  // 画像の位置をバイト単位で覚えるため、文字列に変換する前の Buffer を改行で区切って読みます
  for (let start = 0; start < buf.length; ) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    const line = { offset: start, length: end - start };
    start = end + 1;
    if (!line.length) continue;
    let o;
    try {
      o = JSON.parse(buf.toString('utf8', line.offset, end));
    } catch {
      continue;
    }
    if (o.isSidechain) continue;
    // 処理中に取り込まれた発言は message を持たない attachment 行に記録されるため、先に扱います。
    // 同じ発言の queue-operation 行（enqueue・remove）も message を持たないので、下の判定で読み飛ばされ、二重には表示されません
    if (o.type === 'attachment') {
      const it = queuedPromptItem(o);
      if (it) insertByTime(items, it);
      continue;
    }
    if (!o.message) continue;
    const ts = o.timestamp;
    if (o.type === 'user') {
      if (o.isMeta) continue;
      const special = nonHumanUserItem(o, ts);
      if (special) {
        items.push(special);
        continue;
      }
      const c = o.message.content;
      if (typeof c === 'string') {
        const it = userItem(c, ts);
        if (it) items.push(it);
      } else if (Array.isArray(c)) {
        const results = c.filter((b) => b.type === 'tool_result');
        // toolUseResult は行全体で 1 つなので、寸法はツールの結果が 1 つだけの行に限って使います
        const dims = results.length === 1 ? readDims(o.toolUseResult) : null;
        let lastUser = null;
        for (const b of c) {
          if (b.type === 'text') {
            const it = userItem(b.text, ts);
            if (it) items.push(it);
            if (it?.role === 'user') lastUser = it;
          } else if (b.type === 'tool_result') {
            const item = byId.get(b.tool_use_id);
            if (item) applyResult(item, b, o, { line, images, dims });
            else if (b.is_error) items.push({ role: 'tool_error', text: blockText(b.content).slice(0, 800), ts });
          }
        }
        // 利用者が貼り付けた画像は、同じ行の本文の項目に付けます。本文がなければ画像だけの項目にします
        const imgs = collectImages(c, { kind: 'user', sourceId: o.uuid, line, images });
        if (imgs.length) {
          if (lastUser) lastUser.images = imgs;
          else items.push({ role: 'user', text: '', images: imgs, ts });
        }
      }
    } else if (o.type === 'assistant') {
      for (const b of o.message.content || []) {
        if (b.type === 'text' && b.text.trim()) items.push({ role: 'assistant', text: b.text, ts });
        else if (b.type === 'tool_use') {
          const it = toolItem(b, ts);
          items.push(it);
          if (b.id) byId.set(b.id, it);
        }
      }
    }
  }
  return { items, images };
}

/** 変更があったときだけ読み直したキャッシュを返します */
function load(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const entry = { size: st.size, mtimeMs: st.mtimeMs, ...parse(buf) };
  cache.set(file, entry);
  return entry;
}

export function readTranscript(file, limit = 300) {
  if (!file) return [];
  return load(file)?.items.slice(-limit) || [];
}

// 先頭のバイト列から実際の画像形式を判定します。宣言された MIME タイプだけを信じないためです
export function detectImageType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** 記録した位置の行を読み直し、参照が指す画像を取り出します。行の内容が参照と合わない場合は null を返します */
function readImageAt(file, loc) {
  let o;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(loc.length);
      if (fs.readSync(fd, buf, 0, loc.length, loc.offset) !== loc.length) return null;
      o = JSON.parse(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const c = o?.message?.content;
  if (o?.type !== 'user' || o.isSidechain || !Array.isArray(c)) return null;
  let blocks;
  if (loc.kind === 'tool') blocks = c.find((b) => b?.type === 'tool_result' && b.tool_use_id === loc.sourceId)?.content;
  else if (o.uuid === loc.sourceId) blocks = c;
  if (!Array.isArray(blocks)) return null;
  const b = blocks.filter((x) => x?.type === 'image')[loc.index];
  if (!isImageBlock(b)) return null;
  const data = Buffer.from(b.source.data, 'base64');
  const mime = detectImageType(data);
  // 宣言と中身の両方が対応する形式のときだけ返し、Content-Type には中身から判定した形式を使います
  if (!mime || !IMAGE_TYPES.has(mime)) return null;
  return { mime, data };
}

/**
 * transcript にある画像を参照から取り出します（{ mime, data } または null）。
 * 返すのは、このファイルを読んだときに作った参照が指す画像だけです。任意のファイルやパスは受け付けません。
 * 実行中は transcript が追記され続けるため、読み直しは参照が見つからないときや内容が合わないときだけにして、
 * サムネイルを表示するたびに大きな transcript 全体を読み直さないようにしています（追記だけなので記録した位置は変わりません）。
 */
export function readTranscriptImage(file, ref) {
  if (!file || typeof ref !== 'string') return null;
  const hit = cache.get(file);
  const cached = hit?.images.get(ref);
  if (cached) {
    const img = readImageAt(file, cached);
    if (img) return img;
  }
  const loc = load(file)?.images.get(ref);
  if (!loc || loc === cached) return null;
  return readImageAt(file, loc);
}
