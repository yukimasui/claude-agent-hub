// 依存なしの軽量 Markdown レンダラにゃ。
// 見出し・リスト（入れ子・タスク）・表・引用・水平線・コードブロック・インライン装飾・リンクに対応するにゃ。
// ```mermaid は同梱の mermaid（public/vendor/mermaid/）を遅延読み込みして図にします（読み込めない場合はコードのまま表示します）。

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** インライン装飾にゃ */
export function inline(src) {
  const codes = [];
  let t = esc(src).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = t
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(（])(https?:\/\/[^\s<）)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

function proposalsBlock(code) {
  let items = [];
  let title = '提案';
  try {
    const j = JSON.parse(code);
    title = j.title || title;
    items = (Array.isArray(j) ? j : j.items || []).map((it, i) => ({ id: it.id ?? i + 1, title: it.title ?? it.text ?? '', detail: it.detail ?? '' }));
  } catch {
    return `<pre class="code" data-lang="proposals">${esc(code)}</pre>`;
  }
  return `<div class="proposals-block"><div class="pb-head">${inline(String(title))}</div><ol>${items
    // 補足は改行や箇条書きを含むことがあるため、インライン装飾だけでなく Markdown として描画します
    // （1 行のインライン要素にすると、改行が失われて行頭の「- 」も本文に混ざります）
    .map((it) => `<li><b>${inline(String(it.title))}</b>${it.detail ? `<div class="pb-detail md">${renderMarkdown(String(it.detail))}</div>` : ''}</li>`)
    .join('')}</ol></div>`;
}

function codeBlock(code, lang) {
  if (lang === 'proposals') return proposalsBlock(code);
  if (lang === 'mermaid') {
    return `<div class="mermaid-block"><pre class="code" data-lang="mermaid">${esc(code)}</pre></div>`;
  }
  return `<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ''}>${esc(code)}</pre>`;
}

function isBlockStart(lines, i) {
  const l = lines[i];
  return (
    FENCE_RE.test(l) ||
    HEADING_RE.test(l) ||
    HR_RE.test(l) ||
    /^\s*>/.test(l) ||
    LIST_RE.test(l) ||
    (l.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-'))
  );
}

function parseList(lines, i) {
  const first = lines[i].match(LIST_RE);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  let html = ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>` : '<ul>';
  let open = false;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(LIST_RE);
    if (!line.trim()) {
      const next = lines[i + 1]?.match(LIST_RE);
      if (next && next[1].length >= indent) {
        i++;
        continue;
      }
      break;
    }
    if (!m) {
      // インデントされた継続行にゃ
      if (open && /^\s+/.test(line) && !isBlockStart(lines, i)) {
        html = html.replace(/<\/li>$/, `<br>${inline(line.trim())}</li>`);
        i++;
        continue;
      }
      break;
    }
    if (m[1].length < indent) break;
    // 同じ深さで番号付き／箇条書きが切り替わったら別リストにゃ
    if (m[1].length === indent && /\d/.test(m[2]) !== ordered) break;
    if (m[1].length > indent && open) {
      const r = parseList(lines, i);
      html = html.replace(/<\/li>$/, `${r.html}</li>`);
      i = r.i;
      continue;
    }
    const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
    html += task
      ? `<li class="task"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2])}</li>`
      : `<li>${inline(m[3])}</li>`;
    open = true;
    i++;
  }
  return { html: html + (ordered ? '</ol>' : '</ul>'), i };
}

/** ブロック単位の Markdown を HTML にするにゃ */
export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m = line.match(FENCE_RE);
    if (m) {
      const fence = m[1];
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++;
      html += codeBlock(buf.join('\n'), m[2].toLowerCase());
      continue;
    }
    m = line.match(HEADING_RE);
    if (m) {
      html += `<h${m[1].length} class="md-h">${inline(m[2])}</h${m[1].length}>`;
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      html += '<hr>';
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`;
      continue;
    }
    if (LIST_RE.test(line)) {
      const r = parseList(lines, i);
      html += r.html;
      i = r.i;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const cell = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</${tag}>`;
      html += `<div class="table-wrap"><table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${head.map((_, k) => cell('td', r[k] ?? '', k)).join('')}</tr>`)
        .join('')}</tbody></table></div>`;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines, i))) buf.push(lines[i++]);
    html += `<p>${buf.map(inline).join('<br>')}</p>`;
  }
  return html;
}

// ---------- mermaid ----------

// mermaid はハブのサーバから配信する同梱ファイルを使います。CDN から読み込むと、配信内容が差し替えられた
// 場合に画面と同じオリジンでハブの API を操作できてしまうためです（docs/architecture.md の「mermaid の同梱」）。
// ESM 版は多数のチャンクに分かれているので、1 ファイルで完結する UMD 版を <script> で読み込み、window.mermaid を使います。
export const MERMAID_SRC = '/vendor/mermaid/mermaid.min.js';
const svgCache = new Map();
let mermaidPromise = null;
let seq = 0;

/** classic script として読み込みます。UMD 版は ES モジュールとしては読めないため、import() ではなく <script> を使います */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error(`${src} を読み込めませんでした`));
    };
    document.head.append(s);
  });
}

function loadMermaid() {
  mermaidPromise ||= loadScript(MERMAID_SRC).then(() => {
    const m = window.mermaid;
    if (!m) throw new Error('mermaid が見つかりません');
    m.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
    return m;
  });
  return mermaidPromise;
}

/** 描画後に mermaid ブロックを図へ置き換えるにゃ */
export async function hydrate(root) {
  const blocks = [...root.querySelectorAll('.mermaid-block:not([data-done])')];
  if (!blocks.length) return;
  for (const b of blocks) {
    const src = b.querySelector('pre')?.textContent || '';
    if (svgCache.has(src)) {
      b.dataset.done = '1';
      b.insertAdjacentHTML('afterbegin', `<div class="mermaid-svg">${svgCache.get(src)}</div>`);
      b.querySelector('pre').hidden = true;
    }
  }
  const rest = blocks.filter((b) => !b.dataset.done);
  if (!rest.length) return;
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return; // 同梱ファイルを読み込めない場合は、コードのまま表示します
  }
  for (const b of rest) {
    if (!b.isConnected || b.dataset.done) continue;
    b.dataset.done = '1';
    const src = b.querySelector('pre')?.textContent || '';
    const id = `mmd-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, src);
      svgCache.set(src, svg);
      b.insertAdjacentHTML('afterbegin', `<div class="mermaid-svg">${svg}</div>`);
      b.querySelector('pre').hidden = true;
    } catch {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  }
}
