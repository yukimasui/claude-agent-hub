// Agent Hub のフロントエンドです
import { esc, hydrate, renderMarkdown } from './md.js';
import { mountPending, planHistory, questionHistory, todosHistory } from './cards.js';
import { catAnimationEnabled, catCanvas, coatOf, mountCats, setCatAnimation, updateCat } from './cats.js';
import { queueSignature, renderQueue } from './queue.js';
import { closeBoard, findOpenProposals, isDone, openBoard, parseProposals, proposalKey } from './triage.js';
import { thumbsHtml } from './images.js';
import { SUB_STATE_LABEL, ancestorsOf, subagentCounts, subagentRows } from './subagents.js';
import { contextOver, contextTitle, formatContext, handoffBlockReason, handoffStageLabel, isHandoffActive } from './handoff.js';
import { effortChangeBlockReason } from './effort.js';

const $ = (s) => document.querySelector(s);

const STATE_LABEL = {
  starting: '起動中',
  idle: '待機中',
  running: '実行中',
  waiting: '要対応',
  done: '応答完了',
  compacting: '圧縮中',
  ended: '終了',
};
const ATTENTION_STATES = new Set(['waiting', 'done', 'ended']);
const KIND_LABEL = { question: '質問', plan: '計画の承認', permission: '権限の確認', elicitation: '入力要求' };

let agents = [];
let selectedId = load('selectedId');
// サブエージェントを選んでいるときはその ID です（selectedId は親エージェントのまま）。null なら親エージェントを表示します
let selectedSub = load('selectedSub');
let tab = load('tab') || 'chat';
// 古い完了分をすべて表示している親エージェントと、ツリーを折りたたんでいる親エージェントです
const expandedSubs = new Set();
const collapsedSubs = new Set(loadJson('subCollapsed', []));
const prevStates = new Map();
const seenEventAt = new Map();
const seenPending = new Set();
const attention = new Set();
let pendingSig = '';
let forceScroll = false;
// サーバの設定（/api/info）です。コンテキスト量の目安（contextWarnTokens）を目印の判定に使います
let hubInfo = {};

// ---------- ユーティリティ ----------

function load(k) {
  try {
    return localStorage.getItem('hub.' + k);
  } catch {
    return null;
  }
}
function save(k, v) {
  try {
    v == null ? localStorage.removeItem('hub.' + k) : localStorage.setItem('hub.' + k, v);
  } catch {}
}
function loadJson(k, fallback) {
  try {
    return JSON.parse(load(k)) ?? fallback;
  } catch {
    return fallback;
  }
}

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (method !== 'GET') {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body ?? {});
  }
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { code: j.code, status: r.status });
  return j;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

function elapsed(since) {
  if (!since) return '';
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

const selected = () => agents.find((a) => a.id === selectedId);
const selectedSubagent = () => (selectedSub ? selected()?.subagents?.find((s) => s.id === selectedSub) || null : null);
// 会話の表示対象（親エージェントか、そのサブエージェントか）を表すキーです。スクロール位置の扱いや再読み込みの判定に使います
const viewKey = () => `${selectedId}/${selectedSub || ''}`;

// ---------- サーバとの接続 ----------

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('agents', (e) => onAgents(JSON.parse(e.data)));
  es.onopen = () => $('#conn').classList.add('on');
  es.onerror = () => $('#conn').classList.remove('on');
}

let firstLoad = true;
function onAgents(list) {
  for (const a of list) {
    const prev = prevStates.get(a.id);
    if (prev && prev !== a.state && ATTENTION_STATES.has(a.state) && !a.pending.length) {
      if (a.id !== selectedId || document.hidden) {
        attention.add(a.id);
        notify(`${a.name}: ${STATE_LABEL[a.state]}`, a.activity, a.id);
      }
    }
    prevStates.set(a.id, a.state);
    // 新しい対話要求は個別に通知します
    for (const p of a.pending) {
      if (seenPending.has(p.reqId)) continue;
      seenPending.add(p.reqId);
      if (firstLoad) continue;
      if (a.id !== selectedId || document.hidden) {
        attention.add(a.id);
        notify(`${a.name}: ${KIND_LABEL[p.kind] || '要対応'}`, p.label, a.id);
      }
    }
  }
  firstLoad = false;
  agents = list;
  if (!selected()) {
    // 選んでいたエージェントが削除された場合などです。選択を移すだけでは、移った先の会話を読み直さないことがあり
    // （最後のイベントの時刻が前回の表示時と同じ場合）、前のエージェントの会話や仕分けボードが残るため、select で表示を消してから切り替えます
    const next = agents[0]?.id;
    if (next) select(next);
    else {
      // 保存している選択も消します。残すと、削除済みのエージェントの ID が保存されたままになるためです
      selectedId = null;
      save('selectedId', null);
      setSelectedSub(null);
      $('#chat').innerHTML = '';
      $('#term').textContent = '';
      closeTriage();
    }
  }
  // 選んでいたサブエージェントが一覧から消えた（/clear で新しいセッションになったなど）場合は親エージェントの表示に戻します
  if (selectedSub && !selectedSubagent()) setSelectedSub(null);
  renderList();
  renderDetail();
  const a = selected();
  // サブエージェントの会話は記録ファイルの更新時刻、親エージェントの会話は最後のイベントの時刻が変わったときに読み直します
  const stamp = selectedSub ? selectedSubagent()?.updatedAt : a?.lastEventAt;
  if (a && seenEventAt.get(viewKey()) !== stamp) {
    seenEventAt.set(viewKey(), stamp);
    scheduleTranscript();
  }
  syncPending();
}

function notify(title, body, id) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body: body || '', tag: `${id}-${title}` });
  n.onclick = () => {
    window.focus();
    select(id);
  };
}

// ---------- 描画 ----------

function renderList() {
  const counts = {};
  for (const a of agents) counts[a.state] = (counts[a.state] || 0) + 1;
  $('#summary').innerHTML =
    ['waiting', 'running', 'done', 'idle', 'ended']
      .filter((s) => counts[s])
      .map((s) => `<span class="st-${s}"><b>${counts[s]}</b> ${STATE_LABEL[s]}</span>`)
      .join('') || '<span>エージェントなし</span>';

  $('#agent-list').innerHTML = agents
    .map((a, i) => {
      const since = a.state === 'running' ? a.turnStartedAt : a.stateSince;
      const kinds = [...new Set(a.pending.map((p) => p.kind))];
      const subs = subagentCounts(a.subagents);
      const collapsed = collapsedSubs.has(a.id);
      const subChip = subs.total
        ? `<button type="button" class="chip sub-chip${subs.active ? ' active' : ''}" data-toggle-sub="${a.id}" aria-expanded="${!collapsed}" title="サブエージェント（作業中 / 全体）。押すとツリーを${collapsed ? '開きます' : '折りたたみます'}">${collapsed ? '▸' : '▾'} サブ ${subs.active}/${subs.total}</button>`
        : '';
      return `<li class="agent st-${a.state} state-${a.state}${a.id === selectedId && !selectedSub ? ' selected' : ''}" data-id="${a.id}">
        ${catCanvas({ seed: a.id, coat: a.coat, state: a.state, activity: a.activity, since: a.stateSince, cls: 'cat-icon' })}
        <div class="agent-main">
        <div class="row">
          <span class="idx">${i < 9 ? i + 1 : ''}</span>
          <span class="name">${esc(a.name)}</span>
          ${attention.has(a.id) ? '<span class="attn" title="未確認の更新があります"></span>' : ''}
          <span class="badge">${kinds.length ? esc(kinds.map((k) => KIND_LABEL[k]).join('・')) : STATE_LABEL[a.state] || a.state}</span>
        </div>
        <div class="row">
          <span class="activity">${esc(a.activity)}</span>
          ${a.queue?.length ? `<span class="chip q-chip" title="キューの件数">キュー ${a.queue.length}${a.queuePaused ? '・停止中' : ''}</span>` : ''}
          ${ctxChip(a)}
          ${subChip}
          <span class="elapsed" data-since="${since || ''}">${elapsed(since)}</span>
        </div>
        </div>
      </li>${subs.total && !collapsed ? subtreeHtml(a) : ''}`;
    })
    .join('');

  mountCats($('#agent-list'));

  const pending = agents.filter((a) => a.state === 'waiting' || attention.has(a.id)).length;
  document.title = pending ? `(${pending}) Agent Hub` : 'Agent Hub';
}

/** 一覧のカードに出すコンテキスト量です。目安を超えたら警告の色にします */
function ctxChip(a) {
  const text = formatContext(a.contextTokens);
  if (!text) return '';
  const over = contextOver(a.contextTokens, hubInfo.contextWarnTokens);
  return `<span class="chip ctx-chip${over ? ' warn' : ''}" title="${esc(contextTitle(a.contextTokens, hubInfo.contextWarnTokens))}">${esc(text)}${over ? ' ⚠' : ''}</span>`;
}

/**
 * 親エージェントの行の下に並べるサブエージェントの行です。
 * 親と見分けが付くよう、猫は親の半分の大きさにし、毛色は親と同じにしています（親子であることが分かるように）。
 */
function subtreeHtml(a) {
  const coat = coatOf(a.id, a.coat);
  return subagentRows(a.subagents, { expanded: expandedSubs.has(a.id) })
    .map((r) => {
      if (r.type === 'more') {
        const label = r.expanded ? '古い完了分を隠す' : `完了した ${r.hidden} 件を表示`;
        return `<li class="sub-more" data-id="${a.id}"><button type="button" class="link">${label}</button></li>`;
      }
      const s = r.sub;
      const since = s.state === 'running' || s.state === 'waiting' ? s.startedAt : s.stateSince;
      const label = SUB_STATE_LABEL[s.state] || s.state;
      const sel = a.id === selectedId && s.id === selectedSub ? ' selected' : '';
      return `<li class="sub st-${s.state} state-${s.state}${r.last ? ' last' : ''}${sel}" data-id="${a.id}" data-sub="${esc(s.id)}" style="--depth:${Math.min(r.depth, 4)}" title="${esc(`${s.description}\n${label}: ${s.activity || ''}`)}">
        ${catCanvas({ seed: s.id, coat, state: s.state, activity: s.activity, since: s.stateSince, scale: 1, cls: 'cat-mini' })}
        <span class="sub-name">${esc(s.description)}</span>
        ${s.state === 'waiting' || s.state === 'failed' ? `<span class="sub-state">${label}</span>` : ''}
        <span class="elapsed" data-since="${since || ''}">${elapsed(since)}</span>
      </li>`;
    })
    .join('');
}

/** サブエージェントの会話を表示しているときの詳細画面です（読み取り専用） */
function renderSubDetail(a, s) {
  const chain = [a.name, ...ancestorsOf(a.subagents, s.id).reverse().map((p) => p.description)].join(' › ');
  $('#d-name').textContent = s.description;
  const kind = `${s.agentType || 'サブエージェント'}・${s.background ? 'バックグラウンド' : 'フォアグラウンド'}`;
  $('#d-meta').textContent = `サブエージェント（${kind}） · 親: ${chain} · ${s.id}`;
  $('#d-meta').title = `親: ${chain}\nサブエージェント ID: ${s.id}`;
  const since = s.state === 'running' || s.state === 'waiting' ? s.startedAt : s.stateSince;
  updateCat($('#d-cat canvas'), { seed: s.id, coat: coatOf(a.id, a.coat), state: s.state, activity: s.activity, since: s.stateSince });
  $('#d-badge').className = `badge st-${s.state}`;
  $('#d-badge').textContent = SUB_STATE_LABEL[s.state] || s.state;
  $('#d-act').textContent = s.activity || '';
  $('#d-elapsed').dataset.since = since || '';
  $('#d-elapsed').textContent = elapsed(since);
  $('#sub-parent-name').textContent = a.name;
  $('#chat').hidden = false;
  $('#term').hidden = true;
}

function renderDetail() {
  const a = selected();
  $('#empty').hidden = !!a;
  $('#detail').hidden = !a;
  if (!a) return;
  const sub = selectedSubagent();
  // サブエージェントの表示中は、送信・キー送信・キュー・回答待ちパネルなどの操作部品を隠します
  $('#detail').classList.toggle('sub-view', !!sub);
  if (sub) {
    renderSubDetail(a, sub);
    syncQueue(null);
    return;
  }
  $('#d-name').textContent = a.name;
  const mode = a.currentMode ? ` · mode: ${a.currentMode}` : '';
  // エフォートは右上の選択欄に表示するので、ここには載せません
  $('#d-meta').textContent = `${a.model}${mode} · ${a.cwd} · ${a.sessionId?.slice(0, 8) ?? ''}`;
  $('#d-meta').title = `${a.cwd}\nsession: ${a.sessionId}`;
  const since = a.state === 'running' ? a.turnStartedAt : a.stateSince;
  // ステータス行の要素は作り直さずに中身だけ更新します（猫の動きが途切れないように）
  updateCat($('#d-cat canvas'), { seed: a.id, coat: a.coat, state: a.state, activity: a.activity, since: a.stateSince });
  $('#d-badge').className = `badge st-${a.state}`;
  $('#d-badge').textContent = STATE_LABEL[a.state] || a.state;
  $('#d-act').textContent = a.activity || '';
  $('#d-elapsed').dataset.since = since || '';
  $('#d-elapsed').textContent = elapsed(since);
  $('#btn-restart').disabled = a.alive;
  renderContext(a);
  renderHandoff(a);
  renderEffort(a);
  $('#btn-send').disabled = !a.alive;
  for (const b of document.querySelectorAll('[data-key]')) b.disabled = !a.alive;
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
  $('#chat').hidden = tab !== 'chat';
  $('#term').hidden = tab !== 'term';
  syncQueue(a);
}

/** 詳細のステータス行のコンテキスト量です。目安を超えたら「切り替え推奨」を添えます */
function renderContext(a) {
  const el = $('#d-ctx');
  const text = formatContext(a.contextTokens);
  const over = contextOver(a.contextTokens, hubInfo.contextWarnTokens);
  el.hidden = !text;
  el.classList.toggle('warn', over);
  el.textContent = over ? `${text} ⚠ 切り替え推奨` : text;
  el.title = contextTitle(a.contextTokens, hubInfo.contextWarnTokens);
}

/** エフォートの選択欄です。変更できない間は無効にし、理由を添えます */
function renderEffort(a) {
  const sel = $('#d-effort');
  // 開いている選択欄の値を、画面の更新で書き換えないようにします
  if (document.activeElement !== sel) sel.value = a.effort || '';
  const reason = effortChangeBlockReason(a);
  sel.disabled = !!reason;
  $('#d-effort-label').title = reason
    ? `変更できません: ${reason}`
    : a.alive
      ? '変更すると、会話を引き継いだまま新しいエフォートでエージェントを起動し直します'
      : 'プロセスは終了しています。変更した値は次の再起動で使われます';
}

/** 「引き継いでリセット」のボタンと、段階・結果の表示です */
function renderHandoff(a) {
  const reason = handoffBlockReason(a);
  const btn = $('#btn-handoff');
  btn.disabled = !!reason;
  btn.title = reason ? `実行できません: ${reason}` : '引き継ぎメモを書かせてから /clear し、メモを付けて新しいセッションで再開します';
  const h = a.handoff;
  const bar = $('#handoff-bar');
  bar.hidden = !h;
  if (!h) return;
  const active = isHandoffActive(h);
  bar.className = `handoff-bar ${active ? 'active' : h.stage}`;
  $('#handoff-label').textContent = `引き継いでリセット: ${handoffStageLabel(h)}`;
  $('#handoff-msg').textContent = active ? '完了するまで、送信とキューの自動送信を止めています' : h.message || '';
  // 進行中は閉じられません（サーバも受け付けません）。結果は確かめてから閉じてもらいます
  $('#btn-handoff-dismiss').hidden = active;
}

// ---------- キュー ----------

let queueSig = '';
// 判断待ちの提案の proposalKey（なければ null）と、それを調べた会話のエージェント ID です。
// キューの判断の項目に「古い判断」の目印を付けるために使います。エージェントを切り替えた直後は前のエージェントの値なので使いません
let openProposal = { agentId: null, key: null };
function syncQueue(a) {
  const root = $('#queue');
  const openKey = a && openProposal.agentId === a.id ? openProposal.key : undefined;
  // 「分からない」（undefined）と「判断待ちの提案がない」（null）の変化でも描き直すよう、判定の値は queueSignature で組み立てます
  const sig = queueSignature(a, openKey);
  if (sig === queueSig) return;
  // 編集中は描き直しません（次の更新で反映します）
  if (root.querySelector('textarea:focus') || root.querySelector('.queue-item.dragging')) return;
  queueSig = sig;
  if (!a) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  renderQueue(root, a, async (body) => {
    try {
      await api('POST', `/api/agents/${a.id}/queue`, body);
    } catch (e) {
      toast(e.message);
      queueSig = '';
      syncQueue(selected());
    }
  }, openKey);
}

// ---------- 提案の仕分け ----------

const dismissedTriage = new Set();
let triageKey = null;
let chatItems = [];

function closeTriage() {
  closeBoard($('#triage'));
  triageKey = null;
}

function openTriageFor(it, auto) {
  if (!it || it.role !== 'assistant') return;
  // 判断を求める応答には proposals ブロックを付けるようシステムプロンプトで指示しているため、ブロックの無い箇条書きは対象にしません
  const p = parseProposals(it.text);
  if (!p) return;
  // 途中経過の保存キーは以前と同じ形（エージェント ID|時刻|本文のハッシュ）なので、保存済みの仕分けもそのまま読めます
  const proposal = proposalKey(it);
  const key = `${selectedId}|${proposal}`;
  if (auto && (isDone(key) || dismissedTriage.has(key))) return;
  if (triageKey === key && !$('#triage').hidden) return;
  triageKey = key;
  const agentId = selectedId;
  openBoard($('#triage'), {
    key,
    title: p.title,
    items: p.items,
    onSend: async (text, mode) => {
      const a = agents.find((x) => x.id === agentId);
      try {
        await sendOrQueue(a, text, mode, false, proposal);
        toast(mode === 'queue' ? '判断をキューの先頭に追加しました' : '判断を送信しました');
      } catch (e) {
        toast(e.message);
        throw e;
      }
      triageKey = null;
    },
    onClose: () => {
      dismissedTriage.add(key);
      triageKey = null;
    },
  });
}

/** 最後の応答に未回答の proposals ブロックがあれば自動で開きます */
function autoTriage(items) {
  // サーバがキューを一時停止する判定（lib/queue.js の proposalPauseNote）と同じ関数を使います
  const it = findOpenProposals(items);
  if (it) openTriageFor(it, true);
}

// ---------- 回答待ちパネル ----------

async function syncPending() {
  // サブエージェントの表示中は回答待ちパネルを出しません（回答は親エージェントの表示から行います）
  const a = selectedSub ? null : selected();
  const sig = a ? `${a.id}:${a.pending.map((p) => p.reqId).join(',')}` : '';
  if (sig === pendingSig) return;
  pendingSig = sig;
  const root = $('#pending');
  if (!a || !a.pending.length) {
    // 回答し終えたら会話の最新部分を見せます
    if (!root.hidden) forceScroll = true;
    root.innerHTML = '';
    root.hidden = true;
    return;
  }
  try {
    const { items } = await api('GET', `/api/agents/${a.id}/pending`);
    if (pendingSig !== sig) return; // 取得中に状況が変わった場合です
    mountPending(
      root,
      items,
      (reqId, body) => api('POST', `/api/agents/${a.id}/respond`, { reqId, ...body }),
      (e) => toast(e.message),
    );
    hydrate(root);
  } catch (e) {
    pendingSig = '';
    toast(e.message);
  }
}

// ---------- 会話 ----------

let transcriptTimer;
function scheduleTranscript() {
  clearTimeout(transcriptTimer);
  transcriptTimer = setTimeout(loadTranscript, 150);
}

async function loadTranscript() {
  const a = selected();
  if (!a) return;
  const key = viewKey();
  const sub = selectedSub;
  const url = sub ? `/api/agents/${a.id}/subagents/${encodeURIComponent(sub)}/transcript` : `/api/agents/${a.id}/transcript`;
  try {
    const { items } = await api('GET', url);
    if (key !== viewKey()) return;
    renderChat(items);
    // サブエージェントの会話は提案の判定の対象ではなく、表示中はキューも隠すため、親エージェントの会話のときだけ調べます。
    // サーバがキューを一時停止する判定（lib/queue.js の proposalPauseNote）と同じ関数で、判断待ちの提案を調べます
    if (sub) return;
    const open = findOpenProposals(items);
    openProposal = { agentId: a.id, key: open ? proposalKey(open) : null };
    // 会話の取得中に一覧が更新されている場合があるため、取得前の a ではなく最新のエージェントで描き直します
    syncQueue(selected());
  } catch (e) {
    // サブエージェントの記録が見つからなくなった場合は、親エージェントの表示に戻します
    if (sub && e.status === 404 && key === viewKey()) {
      toast('サブエージェントの記録が見つかりません');
      select(a.id);
      return;
    }
    toast(e.message);
  }
}

function renderChat(items) {
  const el = $('#chat');
  // サブエージェントの会話は読み取り専用なので、提案の仕分けは出しません（判断は親エージェントへ送るものであるため）
  const readOnly = !!selectedSub;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (!items.length) {
    el.innerHTML = '<div class="placeholder">まだ会話がありません。</div>';
    return;
  }
  // 再描画で開閉状態が失われないよう覚えておきます
  const openState = new Map([...el.querySelectorAll('details[data-key]')].map((d) => [d.dataset.key, d.open]));

  let html = '';
  let tools = [];
  const flush = () => {
    if (tools.length) html += `<div class="tools">${tools.join('')}</div>`;
    tools = [];
  };
  chatItems = items;
  for (const [idx, it] of items.entries()) {
    if (it.role === 'tool') {
      tools.push(`<span class="tool${it.error ? ' error' : ''}" title="${esc(it.error || it.summary)}"><b>${esc(it.name)}</b> ${esc(it.summary)}</span>`);
      // ツールが読んだ画像は、その呼び出しのすぐ後ろにサムネイルで表示します
      if (it.images) tools.push(thumbsHtml(selectedId, it.images));
      continue;
    }
    if (it.role === 'tool_error') {
      tools.push(`<span class="tool error">${esc(it.text)}</span>`);
      continue;
    }
    flush();
    if (it.role === 'assistant') {
      const triageable = !readOnly && !!parseProposals(it.text);
      html += `<div class="msg assistant md">${renderMarkdown(it.text)}${
        triageable ? `<div class="msg-tools"><button type="button" class="link triage-btn" data-idx="${idx}" title="項目をカードにして採用・却下・修正を仕分けます">仕分ける</button></div>` : ''
      }</div>`;
    }
    else if (it.role === 'user') {
      // 処理中に送って途中で取り込まれた発言には、いつ指示したかを追えるように目印を付けます
      // 表示する位置は取り込まれた位置ではなく送信した時刻の位置なので、直後の応答がこの発言への返答だと誤読されないよう説明に添えます
      const note = it.queued
        ? '<div class="msg-note" title="エージェントの処理中に送られ、作業の途中で取り込まれた発言です。取り込まれた位置ではなく、送信した時刻の位置に表示しています">処理中に送信</div>'
        : '';
      html += `<div class="msg user">${note}${esc(it.text)}${thumbsHtml(selectedId, it.images)}</div>`;
    }
    else if (it.role === 'question') html += questionHistory(it);
    else if (it.role === 'plan') html += planHistory(it);
    else if (it.role === 'todos') html += todosHistory(it);
    else if (it.role === 'compact') {
      // 圧縮の要約は長いため、既定では閉じておき、必要なときだけ本文を開けるようにします。
      // 再描画で開閉状態を保てるよう、項目ごとに変わらない時刻を data-key に使います
      html += `<details class="msg system compact" data-key="compact-${esc(it.ts || idx)}"><summary>会話を圧縮しました</summary><div class="compact-body">${esc(it.text)}</div></details>`;
    }
    else html += `<div class="msg system">${esc(it.text)}</div>`;
  }
  flush();
  el.innerHTML = html;
  for (const d of el.querySelectorAll('details[data-key]')) if (openState.has(d.dataset.key)) d.open = openState.get(d.dataset.key);
  hydrate(el);
  if (!readOnly) autoTriage(items);
  if (atBottom || forceScroll || el.dataset.agent !== viewKey()) el.scrollTop = el.scrollHeight;
  forceScroll = false;
  el.dataset.agent = viewKey();
}

async function pollScreen() {
  const a = selected();
  if (tab !== 'term' || !a || document.hidden || selectedSub) return;
  try {
    const { text } = await api('GET', `/api/agents/${a.id}/screen`);
    if (a.id === selectedId) $('#term').textContent = text || '（表示できる画面がありません）';
  } catch (e) {
    // ペインが別のエージェントのものだった場合は、前の画面を残さず理由を表示します（別のエージェントの画面と取り違えないためです）
    if (e.code === 'foreign-pane' && a.id === selectedId) $('#term').textContent = e.message;
  }
}

// ---------- 操作 ----------

function setSelectedSub(sub) {
  selectedSub = sub || null;
  save('selectedSub', selectedSub);
}

function select(id) {
  if (!id) return;
  selectedId = id;
  setSelectedSub(null);
  attention.delete(id);
  save('selectedId', id);
  renderList();
  renderDetail();
  $('#chat').innerHTML = '';
  $('#term').textContent = '';
  closeTriage();
  loadTranscript();
  pollScreen();
  syncPending();
  if (!selected()?.pending.length) $('#input').focus();
}

/** サブエージェントを選んで、その会話を読み取り専用で表示します */
function selectSub(id, sub) {
  if (!id || !sub) return;
  selectedId = id;
  setSelectedSub(sub);
  // サブエージェントの表示中は親の会話を読み直さないため、親に戻った直後に古い判定で目印を出さないよう「分からない」に戻します。
  // 親に戻ると会話を読み直し、判断待ちの提案を改めて調べます（loadTranscript）
  openProposal = { agentId: null, key: null };
  save('selectedId', id);
  renderList();
  renderDetail();
  $('#chat').innerHTML = '';
  closeTriage();
  syncPending();
  loadTranscript();
}

function setTab(t) {
  tab = t;
  save('tab', t);
  renderDetail();
  if (t === 'term') pollScreen();
  else loadTranscript();
}

/**
 * 今すぐ送るかキューに積みます。ダイアログ表示中はサーバが送信を拒否します。
 * proposal は仕分けボードからの判断のときに、対象の提案の proposalKey を渡します。
 * サーバは判断としてキューの先頭に入れて提案による一時停止を解除し、送る前に対象の提案がまだ判断待ちかを照合します。
 */
async function sendOrQueue(a, text, mode, clearFirst = false, proposal = null) {
  if (!a) throw new Error('エージェントが選択されていません');
  if (mode === 'queue') return api('POST', `/api/agents/${a.id}/queue`, { op: 'add', text, clearFirst, reply: !!proposal, proposal });
  return api('POST', `/api/agents/${a.id}/send`, { text });
}

async function submit(mode) {
  const a = selected();
  const text = $('#input').value;
  if (!a || !text.trim()) return;
  const buttons = [$('#btn-send'), $('#btn-queue')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    await sendOrQueue(a, text, mode, $('#chk-clear').checked);
    $('#input').value = '';
    if (mode === 'queue') toast('キューに追加しました');
  } catch (e) {
    toast(e.code === 'blocked' ? `${e.message}` : e.message);
  } finally {
    $('#btn-send').disabled = !selected()?.alive;
    $('#btn-queue').disabled = false;
  }
}

async function sendKey(key) {
  const a = selected();
  if (!a) return;
  try {
    await api('POST', `/api/agents/${a.id}/keys`, { key });
    setTimeout(pollScreen, 150);
  } catch (e) {
    toast(e.message);
  }
}

function moveSelection(delta) {
  if (!agents.length) return;
  const i = agents.findIndex((a) => a.id === selectedId);
  select(agents[(i + delta + agents.length) % agents.length].id);
}

function nextAttention() {
  const i = agents.findIndex((a) => a.id === selectedId);
  const order = [...agents.slice(i + 1), ...agents.slice(0, i + 1)];
  const next = order.find((a) => a.pending.length) || order.find((a) => a.state === 'waiting') || order.find((a) => attention.has(a.id));
  if (next) select(next.id);
}

// ---------- イベント登録 ----------

$('#agent-list').addEventListener('click', (e) => {
  // ツリーの開閉は、選択を変えずにその親エージェントの表示だけを切り替えます
  const toggle = e.target.closest('[data-toggle-sub]');
  if (toggle) {
    const id = toggle.dataset.toggleSub;
    collapsedSubs.has(id) ? collapsedSubs.delete(id) : collapsedSubs.add(id);
    save('subCollapsed', JSON.stringify([...collapsedSubs]));
    renderList();
    return;
  }
  const more = e.target.closest('.sub-more');
  if (more) {
    const id = more.dataset.id;
    expandedSubs.has(id) ? expandedSubs.delete(id) : expandedSubs.add(id);
    renderList();
    return;
  }
  const sub = e.target.closest('.sub');
  if (sub) return selectSub(sub.dataset.id, sub.dataset.sub);
  const li = e.target.closest('.agent');
  if (li) select(li.dataset.id);
});
$('#btn-sub-parent').addEventListener('click', () => select(selectedId));
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
for (const b of document.querySelectorAll('[data-key]')) b.addEventListener('click', () => sendKey(b.dataset.key));

$('#btn-send').addEventListener('click', () => submit('now'));
$('#btn-queue').addEventListener('click', () => submit('queue'));
$('#input').addEventListener('keydown', (e) => {
  // IME 変換確定の Enter では送信しません
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    submit(e.ctrlKey || e.metaKey ? 'queue' : 'now');
  }
});
$('#chat').addEventListener('click', (e) => {
  const b = e.target.closest('.triage-btn');
  if (b) openTriageFor(chatItems[Number(b.dataset.idx)], false);
  const t = e.target.closest('.thumb');
  if (t) openImage(t.dataset.src, t.querySelector('img')?.alt || '');
});

// サムネイルを押すと、画像を原寸で表示します（大きい画像はダイアログ内でスクロールします）
function openImage(src, alt) {
  const img = $('#viewer-img');
  img.src = src;
  img.alt = alt;
  $('#viewer-open').href = src;
  $('#dlg-image').showModal();
}
// 画像の外側（背景）を押しても閉じられるようにします
$('#dlg-image').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

$('#btn-focus').addEventListener('click', async () => {
  const a = selected();
  if (!a) return;
  try {
    await api('POST', `/api/agents/${a.id}/focus`);
    const info = await api('GET', '/api/info');
    toast(`tmux で選択しました（未アタッチの場合: tmux attach -t ${info.tmuxSession}）`);
  } catch (e) {
    toast(e.message);
  }
});
$('#btn-handoff').addEventListener('click', async () => {
  const a = selected();
  if (!a || handoffBlockReason(a)) return;
  const ok = confirm(
    `「${a.name}」で引き継いでリセットを実行しますか？\n\n` +
      '1. 引き継ぎメモを応答として書くよう指示します\n' +
      '2. 応答が終わったらメモを保存し、/clear で会話をリセットします\n' +
      '3. 新しいセッションの最初の指示として、メモを付けて再開を指示します\n\n' +
      '実行中はキューの自動送信と入力欄からの送信を止めます。メモを取り出せなかった場合は /clear せずに止めます。',
  );
  if (!ok) return;
  try {
    await api('POST', `/api/agents/${a.id}/handoff`, { op: 'start' });
  } catch (e) {
    toast(e.message);
  }
});
$('#btn-handoff-dismiss').addEventListener('click', async () => {
  const a = selected();
  if (!a) return;
  try {
    await api('POST', `/api/agents/${a.id}/handoff`, { op: 'dismiss' });
  } catch (e) {
    toast(e.message);
  }
});
$('#d-effort').addEventListener('change', async (e) => {
  const sel = e.target;
  const a = selected();
  if (!a) return;
  const effort = sel.value;
  const label = effort || 'ユーザー設定に従う';
  // 動いているエージェントは起動し直すため、実行中のバックグラウンドの処理が止まることなどを確かめてもらいます
  if (
    a.alive &&
    !confirm(
      `「${a.name}」のエフォートを「${label}」に変更しますか？\n\n` +
        '会話を引き継いだまま、新しいエフォートでエージェントを起動し直します（数秒かかります）。\n' +
        'バックグラウンドで動いている処理は止まり、ターミナルで変えた権限モードやモデルは起動時の値に戻ります。',
    )
  ) {
    sel.value = a.effort || '';
    sel.blur();
    return;
  }
  sel.blur();
  try {
    await api('POST', `/api/agents/${a.id}/effort`, { effort });
    toast(a.alive ? `エフォートを「${label}」にして起動し直しています` : `エフォートを「${label}」に変更しました。次の再起動で使われます`);
  } catch (err) {
    sel.value = a.effort || '';
    toast(err.message);
  }
});
$('#btn-restart').addEventListener('click', async () => {
  const a = selected();
  if (!a) return;
  try {
    await api('POST', `/api/agents/${a.id}/restart`);
  } catch (e) {
    toast(e.message);
  }
});
$('#btn-kill').addEventListener('click', async () => {
  const a = selected();
  if (!a || !confirm(`「${a.name}」を削除しますか？ tmux ウィンドウも終了します。`)) return;
  try {
    const r = await api('DELETE', `/api/agents/${a.id}`);
    if (r.windowKept) toast(r.note);
  } catch (e) {
    toast(e.message);
  }
});

$('#btn-new').addEventListener('click', () => {
  $('#form-new').reset();
  $('#dlg-new').showModal();
  $('#form-new [name=name]').focus();
});
$('#dlg-new').addEventListener('close', async () => {
  if ($('#dlg-new').returnValue !== 'ok') return;
  const body = Object.fromEntries(new FormData($('#form-new')));
  try {
    const a = await api('POST', '/api/agents', body);
    selectedId = a.id;
    save('selectedId', a.id);
    // 起動直後は信頼確認などが出ることがあるのでターミナルを見せます
    setTab('term');
  } catch (e) {
    toast(e.message);
  }
});

if ('Notification' in window && Notification.permission === 'default') {
  const b = $('#btn-notify');
  b.hidden = false;
  b.addEventListener('click', async () => {
    await Notification.requestPermission();
    b.hidden = true;
  });
}

// 猫のアニメーションの切り替えです（設定はブラウザに保存されます）
const catAnimButton = $('#btn-cat-anim');
const labelCatAnim = () => {
  catAnimButton.textContent = `猫のアニメーション: ${catAnimationEnabled() ? 'オン' : 'オフ'}`;
};
labelCatAnim();
catAnimButton.addEventListener('click', () => {
  setCatAnimation(!catAnimationEnabled());
  labelCatAnim();
});

document.addEventListener('keydown', (e) => {
  // 提案の拡大表示を開いている間は、エージェントの選択を切り替えません（切り替えるとボードごと閉じ、読んでいた提案を見失うため）
  if ($('#dlg-new').open || $('#dlg-image').open || document.querySelector('.tri-viewer[open]') || !e.altKey) return;
  if (e.key === 'ArrowUp') moveSelection(-1);
  else if (e.key === 'ArrowDown') moveSelection(1);
  else if (/^[1-9]$/.test(e.key)) select(agents[Number(e.key) - 1]?.id);
  else if (e.key.toLowerCase() === 'w') nextAttention();
  else return;
  e.preventDefault();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && selectedId) {
    attention.delete(selectedId);
    renderList();
  }
});

setInterval(() => {
  for (const el of document.querySelectorAll('.elapsed[data-since]')) el.textContent = elapsed(Number(el.dataset.since) || 0);
}, 1000);
setInterval(pollScreen, 800);

// ステータス行の帯と空画面の猫を用意します
$('#d-cat').innerHTML = catCanvas({ seed: '', state: 'idle', w: 64, h: 16, scale: 2 });
$('#empty-cat').innerHTML = catCanvas({ seed: 'hub', coat: 'orange', state: 'idle', since: 1, scale: 4 });
mountCats($('#empty'));

renderDetail();
connect();
api('GET', '/api/info')
  .then((info) => {
    hubInfo = info;
    renderList();
    renderDetail();
  })
  .catch(() => {});
