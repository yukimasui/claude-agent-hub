// Claude Code の transcript JSONL を会話表示用に整形します
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';

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

// 端末の制御用のエスケープシーケンスです（色などの CSI、リンクなどの OSC、そのほかの ESC シーケンス、単独の ESC の順に照合します）。
// そのほかの ESC シーケンスは ECMA-48 の形（中間文字 0x20〜0x2F の並びと、終端文字 0x30〜0x7E）で照合し、
// ESC ( B（文字集合の指定）や ESC 7（カーソル位置の保存）のように ESC の後ろの文字が表示に残らないようにします。
// コマンドの出力は端末に表示するための文字列なので、画面ではこれらが文字化けのように見えるため取り除きます
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]?/g;
// /compact のコマンドの行と、スラッシュコマンドの出力の行です（要約との並び順を直すときに使います）
const COMPACT_CMD_RE = /<command-name>\s*\/compact\s*<\/command-name>/;
const COMMAND_OUTPUT_RE = /<local-command-std(?:out|err)>/;
// コマンドの出力に含まれる hook の実行結果の行です（例: PreCompact ['<node のパス>' '<スクリプトのパス>'] completed successfully）。
// 利用者が自分で設定した hook は、引用符のない形（例: PreCompact [/path/to/hook.sh] completed successfully）でも表示されます。
// 引用符のない引数も受け付ける代わりに、行の先頭を Claude Code の hook イベント名に限り、ほかの出力の行を取り違えないようにしています
const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'UserPromptSubmit',
  'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'Setup',
  'Elicitation', 'ElicitationResult', 'ConfigChange', 'InstructionsLoaded', 'TeammateIdle', 'TaskCreated', 'TaskCompleted',
  'WorktreeCreate', 'WorktreeRemove', 'CwdChanged', 'FileChanged',
];
// 引数は引用符で囲んだものか、空白・引用符・閉じかっこを含まない並びです。
// 引用符のない引数は空白か閉じかっこの直前までを 1 つとし、同じ文字の並びを何通りにも区切って照合し直すことがないようにしています
const HOOK_ARG = `'[^']*'|"[^"]*"|[^\\s'"\\]]+(?=[\\s\\]])`;
const HOOK_LINE_RE = new RegExp(`^(${HOOK_EVENTS.join('|')}) \\[((?:\\s*(?:${HOOK_ARG}))+)\\s*\\] (.+)$`);
const HOOK_ARG_RE = /'([^']*)'|"([^"]*)"|([^\s'"\]]+)/g;

// ファイルのパスらしい引数です（オプションではなく、パスの区切りか拡張子を含むもの）
const FILE_ARG_RE = /^(?!-).*(?:[\\/]|\.[A-Za-z0-9]+$)/;

/**
 * hook の実行結果の行を「<イベント名> の hook（<ファイル名>）: <結果>」の形にします。それ以外の行はそのまま返します。
 * コマンドの絶対パスは長く読みにくいうえ、利用者の環境のパスを画面に出す必要もないため、ファイル名だけを残します。
 * 実行するスクリプトは「node <スクリプト>」のように後ろに置かれることが多い一方、その後ろにオプションや値が
 * 続くこともあるため、ファイルのパスらしい引数のうち最後のものを使います。そのような引数がなければコマンドの名前を使います。
 * 結果に付く空の出力（: {}）は情報がないので省きます。
 *
 * 既知の制約: オプションの値にパスを渡す形（例: node hook.cjs --out /tmp/log.txt）では、値のファイル名（log.txt）を表示します。
 * 引数の並びだけでは、値を取るオプションの後ろのパス（--out /tmp/log.txt）と、値を取らないオプションの後ろに置いた
 * スクリプト（bash -x /path/hook.sh）を区別できないためです。オプションの直後のパスを除くと後者でスクリプト名が
 * 表示されなくなり、どのオプションが値を取るかはコマンドごとに異なります。影響は表示だけなので、この形のままにしています。
 */
function formatHookLine(line) {
  const m = line.match(HOOK_LINE_RE);
  if (!m) return line;
  const args = [...m[2].matchAll(HOOK_ARG_RE)].map((x) => x[1] ?? x[2] ?? x[3]);
  const file = args.findLast((a) => FILE_ARG_RE.test(a)) ?? args[0];
  const name = file.split(/[\\/]/).pop() || file;
  return `${m[1]} の hook（${name}）: ${m[3].replace(/: \{\}$/, '')}`;
}

/** スラッシュコマンドの出力（local-command-stdout / stderr）を表示用に整えます */
function formatCommandOutput(text) {
  return text
    .replace(ANSI_RE, '')
    .split('\n')
    .map((l) => formatHookLine(l.trimEnd()))
    .join('\n')
    .trim();
}

function userItem(text, ts) {
  // ハブから送った長文は Claude Code が貼り付け扱いでタグに包むので、表示では外します
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
  if (out) {
    const text = formatCommandOutput(out[1]);
    return text ? { role: 'system', text, ts } : null;
  }
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

/** ツール呼び出しを表示用アイテムにします。結果は後から tool_result で埋めます */
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

function parse(buf, { sidechain = false } = {}) {
  const items = [];
  const byId = new Map();
  const images = new Map(); // 画像の参照 -> transcript 上の位置
  let movedCompact = null; // /compact の行の後ろへ並べ直した要約の項目（続くコマンドの出力も前に並べるために覚えます）
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
    // 親の transcript ではサブエージェント内のやり取り（isSidechain）を除きます。
    // サブエージェントの transcript はすべての行が isSidechain なので、そのときは逆にその行だけを読みます
    if (!!o.isSidechain !== sidechain) continue;
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
        if (it) {
          items.push(it);
          // /compact を実行すると、要約の行がコマンドの行より先に書かれます。
          // 要約の直後に続く /compact の行と、その後に続くコマンドの出力を、要約より前に並べ直します。
          // 要約との間に別の項目がある /compact は別の圧縮なので動かしません。
          // すでに並べ直した要約の後に来た /compact（圧縮の直後にもう一度実行した場合など）も別の実行なので動かしません。
          // また、要約の時刻はコマンドの行より後になるため、要約の時刻のほうが前であれば別の圧縮の要約とみなします
          const prev = items.at(-2);
          const isCompactCmd = COMPACT_CMD_RE.test(c) && prev !== movedCompact && !(Date.parse(prev?.ts) < Date.parse(ts));
          if (prev?.role === 'compact' && (isCompactCmd || (prev === movedCompact && COMMAND_OUTPUT_RE.test(c)))) {
            items.splice(-2, 2, it, prev);
            movedCompact = prev;
          }
        }
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

// サブエージェントの会話は画面で選んだときだけ読むので、キャッシュは最近読んだものに限ります。
// サブエージェントは数が多く、長く動かすハブでキャッシュが増え続けないようにするためです
const SIDECHAIN_CACHE_MAX = 20;
const sidechainKeys = new Set();
function rememberSidechain(key) {
  sidechainKeys.delete(key);
  sidechainKeys.add(key);
  for (const k of sidechainKeys) {
    if (sidechainKeys.size <= SIDECHAIN_CACHE_MAX) break;
    sidechainKeys.delete(k);
    cache.delete(k);
  }
}

/**
 * 変更があったときだけ読み直したキャッシュを返します。
 * サブエージェントの transcript（sidechain）は別のキーで覚え、画像 API が使う親の transcript のキャッシュと混ざらないようにしています。
 */
function load(file, { sidechain = false } = {}) {
  const key = sidechain ? `sidechain:${file}` : file;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = cache.get(key);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const entry = { size: st.size, mtimeMs: st.mtimeMs, ...parse(buf, { sidechain }) };
  if (sidechain) rememberSidechain(key);
  cache.set(key, entry);
  return entry;
}

/**
 * transcript を会話表示用の項目にして、末尾の limit 件を返します。
 * sidechain を true にすると、サブエージェントの transcript（すべての行が isSidechain）として読みます。
 */
export function readTranscript(file, limit = 300, { sidechain = false } = {}) {
  if (!file) return [];
  return load(file, { sidechain })?.items.slice(-limit) || [];
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

// ---------- コンテキスト量 ----------

/**
 * transcript の 1 行（JSON を読んだもの）から、その時点のコンテキスト量（トークン数）を求めます（求められない行は null）。
 * 応答の入力の量（input_tokens + cache_creation_input_tokens + cache_read_input_tokens）が、その時点の会話全体の大きさに当たります。
 * サブエージェント内のやり取り（isSidechain）は親の会話の量ではないため除きます。
 * API エラーなどで作られる合成の応答は使用量がすべて 0 なので、量を 0 に戻さないよう除きます。
 */
export function contextTokensOf(o) {
  if (o?.type !== 'assistant' || o.isSidechain) return null;
  const u = o.message?.usage;
  if (!u || typeof u !== 'object') return null;
  const n = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
  return n > 0 ? n : null;
}

/**
 * transcript の追記された分だけを読み、完全な行を 1 行ずつ consume(state, line) に渡します。
 * コンテキスト量やエフォートのように、すべてのエージェントで繰り返し確かめる値を、transcript 全体を読み直さずに求めるためのものです。
 * ファイルごとに読み終えた位置と state を cache に覚え、短くなったファイルは作り直されたものとして init() から読み直します。
 * 戻り値は、そのファイルの state です（ファイルを読めなければ null）。
 */
function readAppended(cache, file, init, consume) {
  if (!file) return null;
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  let c = cache.get(file);
  if (!c || size < c.offset) c = { offset: 0, rest: '', decoder: new StringDecoder('utf8'), state: init() };
  cache.delete(file);
  cache.set(file, c);
  for (const k of cache.keys()) {
    if (cache.size <= TAIL_CACHE_MAX) break;
    cache.delete(k);
  }
  if (size === c.offset) return c.state;
  const buf = Buffer.alloc(Math.min(size - c.offset, TAIL_READ_MAX));
  let n;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      n = fs.readSync(fd, buf, 0, buf.length, c.offset);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return c.state;
  }
  c.offset += n;
  const lines = (c.rest + c.decoder.write(buf.subarray(0, n))).split('\n');
  c.rest = lines.pop();
  for (const line of lines) consume(c.state, line);
  return c.state;
}

// /clear で新しいセッションになると前の transcript は読まなくなるため、覚えるファイルの数に上限を設けます
const TAIL_CACHE_MAX = 100;
// 1 回の読み込みの上限です。大きな transcript を初めて読むときに一度に読み込まず、残りは次の確認で読みます
const TAIL_READ_MAX = 8 << 20;

// コンテキスト量は一覧に出すためすべてのエージェントで求めます
const usageCache = new Map(); // path -> { offset, rest, decoder, state: { tokens } }

/** transcript の最新の応答から、現在のコンテキスト量（トークン数）を返します（応答がまだなければ null） */
export function readContextTokens(file) {
  const st = readAppended(usageCache, file, () => ({ tokens: null }), (state, line) => {
    // 画像などを含む大きな行を JSON として読まずに済むよう、使用量を含む行だけを読みます
    if (!line.includes('"usage"')) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const t = contextTokensOf(o);
    if (t != null) state.tokens = t;
  });
  return st ? st.tokens : null;
}

// ---------- ローカルコマンド ----------

const commandOutputCache = new Map(); // path -> { offset, rest, decoder, state: { at } }

/**
 * transcript に記録された最後のローカルコマンドの出力（<local-command-stdout> / <local-command-stderr>）の時刻（ミリ秒）を返します（なければ null）。
 * キューから送ったスラッシュコマンドが TUI の中だけで処理されて終わったかを確かめるために使います（lib/queue.js の localCommandPatch）。
 * ローカルコマンドは hook のイベントを出さず、終わったときにこの出力だけを記録するためです。
 * Claude Code 2.1.322 では、/context などは type が system（subtype が local_command）の行に、/effort などは type が user の行に記録されます。
 * スキルやカスタムコマンドは <command-name> の後に展開したプロンプトが続くだけで出力を記録しないため、ローカルコマンドと取り違えません。
 */
export function readLocalCommandOutputAt(file) {
  const st = readAppended(commandOutputCache, file, () => ({ at: null }), (state, line) => {
    if (!line.includes('<local-command-std')) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o?.isSidechain) return;
    const text = o?.type === 'user' ? blockText(o.message?.content) : o?.type === 'system' ? String(o.content ?? '') : '';
    if (!COMMAND_OUTPUT_RE.test(text)) return;
    const at = Date.parse(o.timestamp);
    if (Number.isFinite(at)) state.at = at;
  });
  return st ? st.at : null;
}

// ---------- エフォート ----------

const EFFORT_RE = '(low|medium|high|xhigh|max)';
// /effort が変更に成功したときの出力です（Claude Code 2.1.322 で確認）。
// - 「Set effort level to high (saved as your default for new sessions): …」「Set effort level to max (this session only): …」
// - 上限を超えた値を指定して上限に合わせられたとき: 「Effort 'max' exceeds the cap for … ; set to 'high' instead …」
// - 「Effort level set to auto」（と「 (this session only)」などの続き）
// 次のものは変更されていない（またはセッションでは効いていない）ので、どれにも一致させません。
// 「Invalid argument: …」「Failed to set effort level: …」「Not applied: CLAUDE_CODE_EFFORT_LEVEL=…」「CLAUDE_CODE_EFFORT_LEVEL=… overrides this session …」、
// 「Effort set to auto for this session, but …」「Cleared effort from settings, but …」（環境変数が優先されている場合）、
// 「Current effort level: …」「Effort level: auto …」（現在の値の表示）、使い方の表示、Ultracode の切り替え
const EFFORT_SET_RE = new RegExp(`^Set effort level to ${EFFORT_RE}\\b`);
const EFFORT_CAPPED_RE = new RegExp(`^Effort '[^']*' exceeds the cap .*?; set to '${EFFORT_RE}' instead`, 's');
const EFFORT_AUTO_RE = /^Effort level set to auto\b/;

/**
 * /effort の出力（local-command-stdout の中身）から、変更後のエフォートを返します。
 * auto は「ユーザー設定に従う」（--effort を付けない）として空文字を返し、変更に成功していない出力には undefined を返します。
 * auto と --effort を付けないことは厳密には同じではありません（/effort auto は利用者の設定にあるそのモデルの既定も消すため、
 * 次の起動ではモデルの既定になります）が、ハブが付け直す --effort としてはどちらも「付けない」が正しいため、同じ値にまとめています。
 */
export function effortFromCommandOutput(text) {
  const t = String(text ?? '').replace(ANSI_RE, '').trim();
  const m = t.match(EFFORT_SET_RE) || t.match(EFFORT_CAPPED_RE);
  if (m) return m[1];
  if (EFFORT_AUTO_RE.test(t)) return '';
  return undefined;
}

const effortCache = new Map(); // path -> { offset, rest, decoder, state: { last, afterEffort } }

/**
 * transcript に残る /effort の実行結果のうち、最後に変更に成功したものを { value, at } で返します（なければ null）。
 * at は行の時刻（ミリ秒）で、呼び出し側が、今のプロセスより前の実行や、ハブから変えた後の古い実行を除くために使います。
 * TUI で打ったスラッシュコマンドは、<command-name> の行に続けて出力（<local-command-stdout>）の行が記録されるため、
 * 直前のコマンドが /effort だった出力だけを読みます。ほかのコマンドの出力を取り違えないためです。
 */
export function readEffortChange(file) {
  const st = readAppended(effortCache, file, () => ({ last: null, afterEffort: false }), (state, line) => {
    // コマンドの行と出力の行だけを JSON として読みます
    if (!line.includes('<command-name>') && !line.includes('<local-command-std')) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o?.type !== 'user' || o.isSidechain || !o.message) return;
    const text = blockText(o.message.content);
    const cmd = text.match(/<command-name>(.*?)<\/command-name>/s);
    if (cmd) {
      state.afterEffort = cmd[1].trim() === '/effort';
      return;
    }
    const out = text.match(/<local-command-stdout>(.*?)<\/local-command-stdout>/s);
    if (!out && !text.includes('<local-command-std')) return;
    if (state.afterEffort && out) {
      const value = effortFromCommandOutput(out[1]);
      const at = Date.parse(o.timestamp);
      if (value !== undefined && Number.isFinite(at)) state.last = { value, at };
    }
    state.afterEffort = false;
  });
  return st ? st.last : null;
}
