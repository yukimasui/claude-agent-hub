// 提案の仕分けボードにゃ。
// Claude が出した提案をカードにして、ドラッグ＆ドロップ（またはボタン）で
// 「採用 / 却下 / 修正して実施」に振り分け、まとめて返信するにゃ
import { esc, hydrate, inline, renderMarkdown } from './md.js';

export const DECISIONS = [
  { key: 'none', label: '未判断' },
  { key: 'ok', label: '採用' },
  { key: 'ng', label: '却下' },
  { key: 'change', label: '修正して実施' },
];

// ---------- 提案の抽出 ----------

/**
 * ```proposals ブロックを探して {title, items} を返します（項目を取り出せなければ null）。
 * 書き損じたブロックの後に書き直したブロックが続く応答もあるため、項目を取り出せる最初のブロックを使います。
 * サーバもキューを一時停止するかどうかをこの関数で判定するため、DOM や Node 専用の API は使いません。
 */
export function parseProposals(text) {
  for (const m of String(text || '').matchAll(/```proposals[^\n]*\n([\s\S]*?)```/g)) {
    const p = parseBlock(m[1].trim());
    if (p) return p;
  }
  return null;
}

/** ブロックの中身を JSON として、読めなければ箇条書きとして解釈します */
function parseBlock(body) {
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

/**
 * 会話の項目（readTranscript の結果）から、まだ返答していない提案を含む応答を探して返します（無ければ null）。
 * 最後の利用者の発言より後にある応答を新しい順に見て、parseProposals で項目を取り出せる最初の応答を選びます。
 * 画面の仕分けボードの自動表示と、サーバのキューの一時停止の両方がこの関数を使い、判定の基準をそろえています。
 */
export function findOpenProposals(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.role === 'user') return null;
    if (it.role === 'assistant' && parseProposals(it.text)) return it;
  }
  return null;
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

// ---------- 拡大表示 ----------

// 拡大表示の判断ボタンです。ボードのカードと同じキーで操作できるよう、キーの割り当てもここにまとめます
const VIEWER_BUTTONS = [
  { to: 'ok', icon: '✓', label: '採用', key: 'A' },
  { to: 'ng', icon: '✕', label: '却下', key: 'X' },
  { to: 'change', icon: '✎', label: '修正して実施', key: 'E' },
  { to: 'none', icon: '↩', label: '未判断に戻す', key: 'U' },
];

/**
 * items の並び（提案に書かれた順）で、id の delta 件先の提案の id を返します（範囲外や見つからない場合は null）。
 * 判断を変えるとカードの列は変わりますが、提案を順に読み進められるよう、移動は元の並びに沿って行います。
 */
export function neighborId(items, id, delta) {
  const i = items.findIndex((it) => it.id === id);
  if (i < 0) return null;
  return items[i + delta]?.id ?? null;
}

/**
 * 提案 1 件を拡大表示する HTML を返します（id が見つからなければ空文字）。
 * 小さなカードでは読みにくい補足を Markdown として描画し、判断と修正内容の入力もこの中で行えるようにします。
 * テストできるよう DOM には触れず、文字列だけを組み立てます。
 */
export function viewerHtml(items, id) {
  const index = items.findIndex((it) => it.id === id);
  const it = items[index];
  if (!it) return '';
  const judged = items.filter((x) => x.decision !== 'none').length;
  const label = DECISIONS.find((d) => d.key === it.decision)?.label || '未判断';
  const buttons = VIEWER_BUTTONS.map(
    (b) =>
      `<button type="button" class="tv-btn tv-btn-${b.to}" data-to="${b.to}" aria-pressed="${it.decision === b.to}" title="${b.label} (${b.key})">${b.icon} ${b.label}<kbd>${b.key}</kbd></button>`,
  ).join('');
  return `<div class="tv" data-id="${esc(it.id)}" data-decision="${esc(it.decision)}">
      <header class="tv-head">
        <span class="tv-pos">提案 ${index + 1} / ${items.length}</span>
        <span class="tv-state">${esc(label)}</span>
        <span class="muted tv-judged">${items.length}件中 ${judged}件を判断済み</span>
        <span class="spacer"></span>
        <button type="button" data-nav="-1" title="前の提案 (←)"${index > 0 ? '' : ' disabled'}>← 前へ</button>
        <button type="button" data-nav="1" title="次の提案 (→)"${index < items.length - 1 ? '' : ' disabled'}>次へ →</button>
        <button type="button" class="ghost" data-act="viewer-close" title="閉じる (Esc)">閉じる</button>
      </header>
      <div class="tv-scroll" tabindex="-1">
        <h3 class="tv-title"><span class="tv-num">${esc(it.id)}</span><span>${inline(it.title)}</span></h3>
        ${it.detail ? `<div class="tv-detail md">${renderMarkdown(it.detail)}</div>` : '<p class="tv-detail tv-empty">補足の説明はありません。</p>'}
      </div>
      <footer class="tv-foot">
        ${
          it.decision === 'change'
            ? `<label class="tv-note-label">修正内容<textarea class="tri-note tv-note" rows="3" placeholder="どのように修正して実施するかを入力してください">${esc(it.note)}</textarea></label>`
            : ''
        }
        <div class="tv-btns">${buttons}</div>
        <div class="hint">← → で前後の提案へ移動 / Esc または背景のクリックで閉じる</div>
      </footer>
    </div>`;
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
      <div class="tri-title"><span class="tri-num">${esc(it.id)}</span><span class="tri-text">${inline(it.title)}</span><button type="button" class="tri-expand" data-view title="拡大表示 (Enter)" aria-label="拡大表示">⤢</button></div>
      ${it.detail ? `<div class="tri-detail">${inline(it.detail).replace(/\n/g, '<br>')}</div>` : ''}
      ${it.decision === 'change' ? `<textarea class="tri-note" rows="2" placeholder="どのように修正して実施するかを入力してください">${esc(it.note)}</textarea>` : ''}
      <div class="tri-btns">
        ${it.decision !== 'ok' ? '<button type="button" data-to="ok" title="採用 (A)">✓ 採用</button>' : ''}
        ${it.decision !== 'ng' ? '<button type="button" data-to="ng" title="却下 (X)">✕ 却下</button>' : ''}
        ${it.decision !== 'change' ? '<button type="button" data-to="change" title="修正して実施 (E)">✎ 修正</button>' : ''}
        ${it.decision !== 'none' ? '<button type="button" data-to="none" title="未判断に戻す (U)">↩</button>' : ''}
      </div>
    </div>`;

  // ボードを描き直しても拡大表示が閉じないよう、ボード本体とダイアログを分けて置き、描き直すのはボード本体だけにします。
  // ダイアログを root の中に置くのは、ボードと同じイベント処理（root の onclick など）で操作を受け取るためです
  root.innerHTML = '<div class="triage"></div><dialog class="tri-viewer" aria-label="提案の詳細"></dialog>';
  const board = root.querySelector('.triage');
  const viewer = root.querySelector('.tri-viewer');
  let viewing = null; // 拡大表示している提案の id
  let dragged = false; // ドラッグ直後のクリックで拡大表示を開かないための目印
  let pressedBackdrop = false; // 直前に押し始めた位置がダイアログの背景だったか

  const render = (focusId) => {
    const judged = state.items.filter((it) => it.decision !== 'none').length;
    board.innerHTML = `
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
        <button type="button" data-act="queue" title="キューの先頭に入れ、エージェントの作業が終わってから送信します">キューに追加</button>
        <span class="hint">カードをドラッグするか、ボタン・キー（A 採用 / X 却下 / E 修正 / U 戻す）で仕分けできます。カードのクリック（Enter）で拡大表示します</span>
      </footer>`;
    root.hidden = false;
    if (focusId) root.querySelector(`.tri-card[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
  };

  const renderViewer = () => {
    viewer.innerHTML = viewerHtml(state.items, viewing);
    hydrate(viewer);
  };
  const openViewer = (id) => {
    if (!state.items.some((x) => x.id === id)) return;
    viewing = id;
    renderViewer();
    if (!viewer.open) viewer.showModal();
    // 最初のボタンではなく本文にフォーカスを置き、↑↓ や PageDown で長い補足をそのままスクロールできるようにします
    viewer.querySelector('.tv-scroll')?.focus({ preventScroll: true });
  };
  // ダイアログを閉じたら、拡大表示中に入力した修正内容をボードに反映し、見ていたカードにフォーカスを戻します
  viewer.onclose = () => {
    const id = viewing;
    viewing = null;
    viewer.innerHTML = '';
    // ボードごと閉じられた場合（root の中身が消えた場合）は描き直しません
    if (board.isConnected && !root.hidden) render(id);
  };

  const move = (id, to) => {
    const it = state.items.find((x) => x.id === id);
    if (!it || it.decision === to) return;
    it.decision = to;
    persist();
    if (viewing) {
      // 拡大表示中はボードの裏側だけを描き直し、操作の続きは拡大表示の中で行えるようにします。
      // このとき裏側のカードの修正内容の入力欄は、その時点の内容で作られます。拡大表示で続けて入力した内容は
      // state と保存には即時に入りますが、ボードの DOM に入るのは閉じたとき（viewer.onclose の描き直し）だけです。
      // ボードの DOM から値を読む処理を加える場合は、この食い違いに注意してください
      render();
      renderViewer();
      const target = to === 'change' ? viewer.querySelector('.tri-note') : viewer.querySelector('.tv-scroll');
      target?.focus({ preventScroll: true });
      return;
    }
    render(id);
    if (to === 'change') root.querySelector(`.tri-card[data-id="${CSS.escape(id)}"] .tri-note`)?.focus();
  };

  // ---- イベント（root に一度だけ登録するにゃ） ----
  root.onclick = async (e) => {
    // ダイアログの外側（背景）を押したときは、イベントの対象がダイアログ自身になります。
    // 本文の文字を選択しながら背景で離した場合も、押した位置と離した位置の共通の祖先であるダイアログが対象になるため、
    // 押し始めも背景だったときだけ閉じます（読みながら文字を選ぶ操作で閉じてしまわないようにするため）
    if (e.target === viewer) {
      if (pressedBackdrop) viewer.close();
      return;
    }
    const to = e.target.closest('button[data-to]');
    // カードと拡大表示のどちらのボタンも、data-id を持つ親要素から対象の提案を求めます
    if (to) return move(to.closest('[data-id]').dataset.id, to.dataset.to);
    const nav = e.target.closest('button[data-nav]');
    if (nav) return openViewer(neighborId(state.items, viewing, Number(nav.dataset.nav)));
    const card = e.target.closest('.tri-card');
    // カード内の入力欄やリンクの操作では開かないようにします（拡大ボタンは除く）
    if (card && (e.target.closest('button[data-view]') || !e.target.closest('button, textarea, a, input'))) {
      // キーボードで拡大ボタンを押した場合（e.detail が 0）はドラッグの直後ではないため、目印を見ずに開きます
      if (!dragged || e.detail === 0) openViewer(card.dataset.id);
      return;
    }
    const act = e.target.closest('button[data-act]')?.dataset.act;
    if (act === 'viewer-close') {
      viewer.close();
    } else if (act === 'close') {
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
      const it = state.items.find((x) => x.id === e.target.closest('[data-id]').dataset.id);
      if (it) it.note = e.target.value;
      e.target.classList.remove('missing');
      persist();
    } else if (e.target.classList.contains('tri-comment')) {
      state.comment = e.target.value;
      persist();
    }
  };
  root.onkeydown = (e) => {
    if (e.target.matches?.('textarea') || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    const to = { a: 'ok', x: 'ng', e: 'change', u: 'none' }[e.key.toLowerCase()];
    if (viewing && viewer.contains(e.target)) {
      const delta = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (delta) {
        e.preventDefault();
        const id = neighborId(state.items, viewing, delta);
        if (id) openViewer(id);
      } else if (to) {
        e.preventDefault();
        move(viewing, to);
      }
      return;
    }
    const card = e.target.closest?.('.tri-card');
    if (!card) return;
    // フォーカスがカード内のボタンにあるときの Enter・Space は、そのボタンの操作として扱います
    if ((e.key === 'Enter' || e.key === ' ') && e.target === card) {
      e.preventDefault();
      openViewer(card.dataset.id);
    } else if (to) {
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
    dragged = true;
  };
  // 目印は、次にマウスやタッチで押し始めた時点で消します。ドロップでカードを描き直すと、ドラッグ元の要素が文書から外れて
  // dragend が root まで届かないため、dragend では消せません
  root.onpointerdown = (e) => {
    dragged = false;
    pressedBackdrop = e.target === viewer;
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
