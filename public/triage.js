// 提案の仕分けボードです。
// Claude が出した提案をカードにして、ドラッグ＆ドロップ（またはボタン）で
// 「採用 / 却下 / 修正して実施」に振り分け、まとめて返信します
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
  const src = String(text || '');
  const open = /```proposals[^\n]*\n/g;
  for (let m; (m = open.exec(src)); ) {
    const block = readBlock(src, m.index + m[0].length);
    if (!block) return null; // 閉じの無いブロックは提案として扱いません
    if (block.proposals) return block.proposals;
    open.lastIndex = block.end;
  }
  return null;
}

/**
 * start から始まるブロックの中身を読み、{ proposals, end }（end は閉じの区切りの直後）を返します。閉じが無ければ null。
 * 補足にコードブロックがあると、JSON の文字列の中にも区切り（バッククォート 3 つ）が現れます。最初の区切りで切ると
 * JSON が途中で切れて読み取れないため、区切りの候補を順に試し、中身が JSON として読める最初の区切りを閉じとみなします。
 * JSON は後ろに余分な文字があると読めないので、読める最初の範囲がブロックの中身全体になります。
 * どの候補でも JSON として読めない場合は、従来どおり最初の区切りまでを箇条書きとして読みます。
 *
 * 壊れた JSON や箇条書きのブロックでは、すべての候補を試すことになります。候補ごとに中身を切り出して解析すると
 * 「区切りの数 × 本文の長さ」の手間がかかり、会話の再描画のたびに全応答で呼ばれるため長い応答で遅くなります。
 * そこで、中身の先頭が { か [ で、候補の直前（空白を除く）が } か ] のときだけ切り出して解析します。
 * JSON の文字列の中にある区切りの直前はふつうこれらの文字にならないため、解析を試す回数はほぼ 1 回で済みます。
 */
function readBlock(src, start) {
  const first = src.indexOf('```', start);
  if (first < 0) return null;
  // 中身の先頭の文字は候補によらず同じなので、一度だけ調べます
  let head = start;
  while (head < src.length && /\s/.test(src[head])) head++;
  if (src[head] === '{' || src[head] === '[') {
    for (let i = first; i >= 0; i = src.indexOf('```', i + 3)) {
      let tail = i - 1;
      while (tail > head && /\s/.test(src[tail])) tail--;
      if (src[tail] !== '}' && src[tail] !== ']') continue;
      const body = src.slice(head, tail + 1);
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        continue;
      }
      return { proposals: parseBlock(body, json), end: i + 3 };
    }
  }
  return { proposals: parseBlock(src.slice(start, first).trim()), end: first + 3 };
}

/**
 * ブロックの中身を解釈します。readBlock が JSON として読めた場合はその値（json）を受け取り、もう一度解析する手間を省きます。
 * json が無い場合、または JSON から項目を取り出せない場合は、箇条書きとして読みます。
 */
function parseBlock(body, json) {
  if (json && typeof json === 'object') {
    const raw = Array.isArray(json) ? json : json.items;
    const items = (Array.isArray(raw) ? raw : [])
      .map((it, i) => ({
        id: String(it?.id ?? i + 1),
        title: String(it?.title ?? it?.summary ?? it?.text ?? '').trim(),
        detail: String(it?.detail ?? it?.description ?? '').trim(),
      }))
      .filter((it) => it.title);
    if (items.length) return { title: String(json.title || '提案'), items };
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

function hashText(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * 提案を含む応答（findOpenProposals などで得た会話の項目）を見分けるための文字列を返します。
 * 会話の項目には応答ごとの ID がないため、時刻と本文のハッシュを組み合わせます。
 * キューに入れた判断がどの提案に対するものかを記録し、送る前に判断待ちの提案と照合するために使います（lib/queue.js）。
 * 画面とサーバで同じ値になるよう、この関数だけで組み立ててください。
 */
export function proposalKey(it) {
  return `${it.ts}|${hashText(String(it.text ?? ''))}`;
}

/** 本文のトップレベルの箇条書き・番号付きリストを項目として取り出します */
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
    // 古いものから捨てて肥大化を防ぎます
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

// ---------- カードの補足 ----------

/**
 * ボードのカードに載せる補足の HTML を返します（補足が無ければ空文字）。
 * 改行や箇条書きを保つため Markdown として描画します。高さは一覧しやすいよう CSS（.tri-detail）で抑えます。
 * テストできるよう DOM には触れず、文字列だけを組み立てます。
 */
export function cardDetailHtml(detail) {
  return detail ? `<div class="tri-detail md">${renderMarkdown(detail)}</div>` : '';
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

// 描画中のボードの後片付け（大きさの監視を止める処理）を、描画先の要素ごとに持ちます。
// ボードの中身を消すだけでは ResizeObserver が監視を続け、閉じたボードの要素と監視が残るためです
const boardCleanups = new WeakMap();

/**
 * root に描画したボードを閉じます。ボードの外から閉じる場合（表示するエージェントを切り替えたときなど）も、
 * root の中身を直接消さずにこの関数を使います。
 */
export function closeBoard(root) {
  boardCleanups.get(root)?.();
  boardCleanups.delete(root);
  root.hidden = true;
  root.innerHTML = '';
}

/**
 * ボードを root に描画します。
 * opts: { key, title, items, onSend(text, mode) => Promise, onClose() }
 * mode は 'now' か 'queue'
 */
export function openBoard(root, opts) {
  // 前のボードを閉じずに描き直す場合（別の提案を開いた場合など）も、前のボードの監視を止めます
  boardCleanups.get(root)?.();
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
      ${cardDetailHtml(it.detail)}
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

  // カードの補足のうち、高さの上限で続きが隠れているものに clipped を付け、下端のぼかしを出します（style.css の .tri-detail）。
  // 列の幅が変わると折り返しが変わって隠れるかどうかも変わるため、描画後に加えて大きさが変わるたびに測り直します
  const markClipped = (el) => el.classList.toggle('clipped', el.scrollHeight > el.clientHeight + 1);
  const clipObserver = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => entries.forEach((e) => markClipped(e.target))) : null;
  boardCleanups.set(root, () => clipObserver?.disconnect());

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
    clipObserver?.disconnect();
    for (const d of board.querySelectorAll('.tri-detail')) {
      markClipped(d);
      clipObserver?.observe(d);
    }
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

  // ---- イベント（root に一度だけ登録します） ----
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
      closeBoard(root);
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
        closeBoard(root);
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
  // ドラッグ＆ドロップです
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
