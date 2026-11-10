// Claude Code の transcript JSONL を会話表示用に整形するにゃ
import fs from 'node:fs';
import { createRequire } from 'node:module';

const { summarize } = createRequire(import.meta.url)('../hooks/summarize.cjs');

const cache = new Map(); // path -> { size, mtimeMs, items }

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

function applyResult(item, b, o) {
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
  } else if (b.is_error) {
    item.error = text.slice(0, 800);
  }
}

function parse(text) {
  const items = [];
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain || !o.message) continue;
    const ts = o.timestamp;
    if (o.type === 'user') {
      if (o.isMeta) continue;
      const c = o.message.content;
      if (typeof c === 'string') {
        const it = userItem(c, ts);
        if (it) items.push(it);
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text') {
            const it = userItem(b.text, ts);
            if (it) items.push(it);
          } else if (b.type === 'tool_result') {
            const item = byId.get(b.tool_use_id);
            if (item) applyResult(item, b, o);
            else if (b.is_error) items.push({ role: 'tool_error', text: blockText(b.content).slice(0, 800), ts });
          }
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
  return items;
}

export function readTranscript(file, limit = 300) {
  if (!file) return [];
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.items.slice(-limit);
  const items = parse(fs.readFileSync(file, 'utf8'));
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, items });
  return items.slice(-limit);
}
