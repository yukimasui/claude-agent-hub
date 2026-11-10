// 提案の仕分けボードにゃ。
// Claude が出した提案をカードにして、ドラッグ＆ドロップ（またはボタン）で
// 「採用 / 却下 / 修正して実施」に振り分け、まとめて返信するにゃ
import { esc, inline } from './md.js';

export const DECISIONS = [
  { key: 'none', label: '未判断' },
  { key: 'ok', label: '採用' },
  { key: 'ng', label: '却下' },
  { key: 'change', label: '修正して実施' },
];

// ---------- 提案の抽出 ----------

/** ```proposals ブロックを探して {title, items} を返すにゃ */
export function parseProposals(text) {
  const m = String(text || '').match(/```proposals[^\n]*\n([\s\S]*?)```/);
  if (!m) return null;
  const body = m[1].trim();
  try {
    const j = JSON.parse(body);
    const raw = Array.isArray(j) ? j : j.items;
    const items = (raw || [])
      .map((it, i) => ({
        id: String(it.id ?? i + 1),
        title: String(it.title ?? it.summary ?? it.text ?? '').trim(),
        detail: String(it.detail ?? it.description ?? '').trim(),
      }))
      .filter((it) => it.title);
    if (items.length) return { title: String(j.title || '提案'), items };
  } catch {
    // JSON でなければ箇条書きとして読むにゃ
  }
  const items = extractListItems(body);
  return items.length ? { title: '提案', items } : null;
}

/** 本文のトップレベルの箇条書き・番号付きリストを項目として取り出すにゃ */
export function extractListItems(text) {
  const lines = String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .split('\n');
  const items = [];
  for (const line of lines) {
    const m = line.match(/^(\d{1,3}[.)]|[-*+])\s+(.+)$/);
    if (m) {
      items.push({ id: /\d/.test(m[1]) ? m[1].replace(/[.)]/, '') : String(items.length + 1), title: m[2].trim(), detail: '' });
    } else if (items.length && /^\s{2,}\S/.test(line)) {
      const last = items[items.length - 1];
      last.detail = (last.detail ? last.detail + '\n' : '') + line.trim().replace(/^([-*+]|\d+[.)])\s+/, '・');
    }
  }
  return items;
}

// ---------- 状態の保存 ----------

const STORE_KEY = 'hub.triage';
function loadAll() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {
    return {};
  }
}
function saveAll(all) {
  try {
    // 古いものから捨てて肥大化を防ぐにゃ
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete all[k];
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {}
}

export function isDone(key) {
  return !!loadAll()[key]?.done;
}
export function markDone(key) {
  const all = loadAll();
  all[key] = { ...(all[key] || {}), done: true };
  saveAll(all);
}

// ---------- 返信文の組み立て ----------

export function composeReply(state) {
  const by = (d) => state.items.filter((it) => it.decision === d);
  const line = (it) => `- ${it.id}. ${it.title}`;
  const parts = ['提案への判断です。'];
  const ok = by('ok');
  const ng = by('ng');
  const ch = by('change');
  const none = by('none');
  if (ok.length) parts.push(`【採用】\n${ok.map(line).join('\n')}`);
  if (ch.length) parts.push(`【修正して実施】\n${ch.map((it) => `${line(it)}\n  → 指示: ${it.note?.trim() || '（修正内容は相談したい）'}`).join('\n')}`);
  if (ng.length) parts.push(`【却下】\n${ng.map(line).join('\n')}`);
  if (none.length) parts.push(`【保留（今回は判断しない）】\n${none.map(line).join('\n')}`);
  if (state.comment?.trim()) parts.push(`補足: ${state.comment.trim()}`);
  const todo = [];
  if (ok.length || ch.length) todo.push('採用・修正の項目を進めてください');
  if (ng.length) todo.push('却下の項目は対応不要です');
  if (none.length) todo.push('保留の項目には手を付けないでください');
  if (todo.length) parts.push(todo.join('。') + '。');
  return parts.join('\n\n');
}

// ---------- ボード ----------

/**
 * ボードを root に描画するにゃ。
 * opts: { key, title, items, onSend(text, mode) => Promise, onClose() }
 * mode は 'now' か 'queue'
 */
export function openBoard(root, opts) {
  const all = loadAll();
  const saved = all[opts.key];
  const state = {
    title: opts.title,
    comment: saved?.comment || '',
    items: opts.items.map((it) => {
      const prev = saved?.items?.find((x) => x.id === it.id && x.title === it.title);
      return { ...it, decision: prev?.decision || 'none', note: prev?.note || '' };
    }),
  };
  const persist = () => {
    const a = loadAll();
    a[opts.key] = { items: state.items.map(({ id, title, decision, note }) => ({ id, title, decision, note })), comment: state.comment };
    saveAll(a);
  };

  const cardHtml = (it) => `<div class="tri-card" draggable="true" tabindex="0" data-id="${esc(it.id)}">
      <div class="tri-title"><span class="tri-num">${esc(it.id)}</span><span>${inline(it.title)}</span></div>
      ${it.detail ? `<div class="tri-detail">${inline(it.detail).replace(/\n/g, '<br>')}</div>` : ''}
      ${it.decision === 'change' ? `<textarea class="tri-note" rows="2" placeholder="どのように修正して実施するかを入力してください">${esc(it.note)}</textarea>` : ''}
      <div class="tri-btns">
        ${it.decision !== 'ok' ? '<button type="button" data-to="ok" title="採用 (A)">✓ 採用</button>' : ''}
        ${it.decision !== 'ng' ? '<button type="button" data-to="ng" title="却下 (X)">✕ 却下</button>' : ''}
        ${it.decision !== 'change' ? '<button type="button" data-to="change" title="修正して実施 (E)">✎ 修正</button>' : ''}
        ${it.decision !== 'none' ? '<button type="button" data-to="none" title="未判断に戻す (U)">↩</button>' : ''}
      </div>
    </div>`;

  const render = (focusId) => {
    const judged = state.items.filter((it) => it.decision !== 'none').length;
    root.innerHTML = `<div class="triage">
      <header class="tri-head">
        <span class="badge st-waiting">仕分け</span>
        <span class="tri-heading">${inline(state.title)}</span>
        <span class="muted">${state.items.length}件中 ${judged}件を判断済み</span>
        <span class="spacer"></span>
        <button type="button" class="ghost" data-act="all-ok">残りをすべて採用</button>
        <button type="button" class="ghost" data-act="close">閉じる</button>
      </header>
      <div class="tri-cols">
        ${DECISIONS.map(
          (d) => `<section class="tri-col tri-${d.key}" data-decision="${d.key}">
            <h4>${d.label}<span class="muted">${state.items.filter((it) => it.decision === d.key).length}</span></h4>
            <div class="tri-drop">${state.items.filter((it) => it.decision === d.key).map(cardHtml).join('') || '<div class="tri-empty">ここにドロップ</div>'}</div>
          </section>`,
        ).join('')}
      </div>
      <textarea class="tri-comment" rows="2" placeholder="全体へのコメント（任意）">${esc(state.comment)}</textarea>
      <footer class="tri-foot">
        <button type="button" class="primary" data-act="send">判断を送信</button>
        <button type="button" data-act="queue" title="エージェントの作業が終わってから送信します">キューに追加</button>
        <span class="hint">カードをドラッグするか、ボタン・キー（A 採用 / X 却下 / E 修正 / U 戻す）で仕分けできます</span>
      </footer>
    </div>`;
    root.hidden = false;
    if (focusId) root.querySelector(`.tri-card[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
  };

  const move = (id, to) => {
    const it = state.items.find((x) => x.id === id);
    if (!it || it.decision === to) return;
    it.decision = to;
    persist();
    render(id);
    if (to === 'change') root.querySelector(`.tri-card[data-id="${CSS.escape(id)}"] .tri-note`)?.focus();
  };

  // ---- イベント（root に一度だけ登録するにゃ） ----
  root.onclick = async (e) => {
    const to = e.target.closest('button[data-to]');
    if (to) return move(to.closest('.tri-card').dataset.id, to.dataset.to);
    const act = e.target.closest('button[data-act]')?.dataset.act;
    if (act === 'close') {
      root.hidden = true;
      root.innerHTML = '';
      opts.onClose?.();
    } else if (act === 'all-ok') {
      for (const it of state.items) if (it.decision === 'none') it.decision = 'ok';
      persist();
      render();
    } else if (act === 'send' || act === 'queue') {
      const missing = state.items.find((it) => it.decision === 'change' && !it.note.trim());
      if (missing) {
        const ta = root.querySelector(`.tri-card[data-id="${CSS.escape(missing.id)}"] .tri-note`);
        ta?.focus();
        ta?.classList.add('missing');
        return;
      }
      const buttons = root.querySelectorAll('.tri-foot button');
      buttons.forEach((b) => (b.disabled = true));
      try {
        await opts.onSend(composeReply(state), act === 'send' ? 'now' : 'queue');
        markDone(opts.key);
        root.hidden = true;
        root.innerHTML = '';
      } catch {
        buttons.forEach((b) => (b.disabled = false));
      }
    }
  };
  root.oninput = (e) => {
    if (e.target.classList.contains('tri-note')) {
      const it = state.items.find((x) => x.id === e.target.closest('.tri-card').dataset.id);
      if (it) it.note = e.target.value;
      e.target.classList.remove('missing');
      persist();
    } else if (e.target.classList.contains('tri-comment')) {
      state.comment = e.target.value;
      persist();
    }
  };
  root.onkeydown = (e) => {
    const card = e.target.closest?.('.tri-card');
    if (!card || e.target.matches('textarea') || e.altKey || e.ctrlKey || e.metaKey) return;
    const to = { a: 'ok', x: 'ng', e: 'change', u: 'none' }[e.key.toLowerCase()];
    if (to) {
      e.preventDefault();
      move(card.dataset.id, to);
    }
  };
  // ドラッグ＆ドロップにゃ
  root.ondragstart = (e) => {
    const card = e.target.closest?.('.tri-card');
    if (!card) return;
    e.dataTransfer.setData('text/plain', card.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  };
  root.ondragend = (e) => {
    e.target.closest?.('.tri-card')?.classList.remove('dragging');
    root.querySelectorAll('.tri-col.over').forEach((c) => c.classList.remove('over'));
  };
  root.ondragover = (e) => {
    const col = e.target.closest?.('.tri-col');
    if (!col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    root.querySelectorAll('.tri-col.over').forEach((c) => c !== col && c.classList.remove('over'));
    col.classList.add('over');
  };
  root.ondragleave = (e) => {
    const col = e.target.closest?.('.tri-col');
    if (col && !col.contains(e.relatedTarget)) col.classList.remove('over');
  };
  root.ondrop = (e) => {
    const col = e.target.closest?.('.tri-col');
    if (!col) return;
    e.preventDefault();
    move(e.dataTransfer.getData('text/plain'), col.dataset.decision);
  };

  render();
}
