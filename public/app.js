// Agent Hub フロントエンドにゃ
import { esc, hydrate, renderMarkdown } from './md.js';
import { mountPending, planHistory, questionHistory, todosHistory } from './cards.js';
import { catCanvas, mountCats, updateCat } from './cats.js';
import { renderQueue } from './queue.js';
import { extractListItems, isDone, openBoard, parseProposals } from './triage.js';

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
let tab = load('tab') || 'chat';
const prevStates = new Map();
const seenEventAt = new Map();
const seenPending = new Set();
const attention = new Set();
let pendingSig = '';
let forceScroll = false;

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
    // 新しい対話要求は個別に通知するにゃ
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
  if (!selected()) selectedId = agents[0]?.id ?? null;
  renderList();
  renderDetail();
  const a = selected();
  if (a && seenEventAt.get(a.id) !== a.lastEventAt) {
    seenEventAt.set(a.id, a.lastEventAt);
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
      return `<li class="agent st-${a.state} state-${a.state}${a.id === selectedId ? ' selected' : ''}" data-id="${a.id}">
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
          <span class="elapsed" data-since="${since || ''}">${elapsed(since)}</span>
        </div>
        </div>
      </li>`;
    })
    .join('');

  mountCats($('#agent-list'));

  const pending = agents.filter((a) => a.state === 'waiting' || attention.has(a.id)).length;
  document.title = pending ? `(${pending}) Agent Hub` : 'Agent Hub';
}

function renderDetail() {
  const a = selected();
  $('#empty').hidden = !!a;
  $('#detail').hidden = !a;
  if (!a) return;
  $('#d-name').textContent = a.name;
  const mode = a.currentMode ? ` · mode: ${a.currentMode}` : '';
  $('#d-meta').textContent = `${a.model}${mode} · ${a.cwd} · ${a.sessionId?.slice(0, 8) ?? ''}`;
  $('#d-meta').title = `${a.cwd}\nsession: ${a.sessionId}`;
  const since = a.state === 'running' ? a.turnStartedAt : a.stateSince;
  // ステータス行の要素は作り直さずに中身だけ更新するにゃ（猫の動きが途切れないように）
  updateCat($('#d-cat canvas'), { seed: a.id, coat: a.coat, state: a.state, activity: a.activity, since: a.stateSince });
  $('#d-badge').className = `badge st-${a.state}`;
  $('#d-badge').textContent = STATE_LABEL[a.state] || a.state;
  $('#d-act').textContent = a.activity || '';
  $('#d-elapsed').dataset.since = since || '';
  $('#d-elapsed').textContent = elapsed(since);
  $('#btn-restart').disabled = a.alive;
  $('#btn-send').disabled = !a.alive;
  for (const b of document.querySelectorAll('[data-key]')) b.disabled = !a.alive;
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
  $('#chat').hidden = tab !== 'chat';
  $('#term').hidden = tab !== 'term';
  syncQueue(a);
}

// ---------- キュー ----------

let queueSig = '';
function syncQueue(a) {
  const root = $('#queue');
  const busy = a && ['running', 'waiting', 'compacting'].includes(a.state);
  const sig = a ? JSON.stringify([a.id, a.queue, a.queuePaused, a.queueNote, busy]) : '';
  if (sig === queueSig) return;
  // 編集中は描き直さないにゃ（次の更新で反映するにゃ）
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
  });
}

// ---------- 提案の仕分け ----------

const dismissedTriage = new Set();
let triageKey = null;
let chatItems = [];

function hashText(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function closeTriage() {
  $('#triage').hidden = true;
  $('#triage').innerHTML = '';
  triageKey = null;
}

function openTriageFor(it, auto) {
  if (!it || it.role !== 'assistant') return;
  const p = parseProposals(it.text) || { title: '提案の仕分け', items: extractListItems(it.text) };
  if (!p.items.length) return;
  const key = `${selectedId}|${it.ts}|${hashText(it.text)}`;
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
        await sendOrQueue(a, text, mode);
        toast(mode === 'queue' ? '判断をキューに追加しました' : '判断を送信しました');
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

/** 最後の応答に未回答の proposals ブロックがあれば自動で開くにゃ */
function autoTriage(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.role === 'user') return;
    if (it.role === 'assistant' && parseProposals(it.text)) return openTriageFor(it, true);
  }
}

// ---------- 回答待ちパネル ----------

async function syncPending() {
  const a = selected();
  const sig = a ? `${a.id}:${a.pending.map((p) => p.reqId).join(',')}` : '';
  if (sig === pendingSig) return;
  pendingSig = sig;
  const root = $('#pending');
  if (!a || !a.pending.length) {
    // 回答し終えたら会話の最新部分を見せるにゃ
    if (!root.hidden) forceScroll = true;
    root.innerHTML = '';
    root.hidden = true;
    return;
  }
  try {
    const { items } = await api('GET', `/api/agents/${a.id}/pending`);
    if (pendingSig !== sig) return; // 取得中に状況が変わったにゃ
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
  const id = a.id;
  try {
    const { items } = await api('GET', `/api/agents/${id}/transcript`);
    if (id === selectedId) renderChat(items);
  } catch (e) {
    toast(e.message);
  }
}

function renderChat(items) {
  const el = $('#chat');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (!items.length) {
    el.innerHTML = '<div class="placeholder">まだ会話がありません。</div>';
    return;
  }
  // 再描画で開閉状態が失われないよう覚えておくにゃ
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
      continue;
    }
    if (it.role === 'tool_error') {
      tools.push(`<span class="tool error">${esc(it.text)}</span>`);
      continue;
    }
    flush();
    if (it.role === 'assistant') {
      const triageable = parseProposals(it.text) || extractListItems(it.text).length >= 2;
      html += `<div class="msg assistant md">${renderMarkdown(it.text)}${
        triageable ? `<div class="msg-tools"><button type="button" class="link triage-btn" data-idx="${idx}" title="項目をカードにして採用・却下・修正を仕分けます">仕分ける</button></div>` : ''
      }</div>`;
    }
    else if (it.role === 'user') html += `<div class="msg user">${esc(it.text)}</div>`;
    else if (it.role === 'question') html += questionHistory(it);
    else if (it.role === 'plan') html += planHistory(it);
    else if (it.role === 'todos') html += todosHistory(it);
    else html += `<div class="msg system">${esc(it.text)}</div>`;
  }
  flush();
  el.innerHTML = html;
  for (const d of el.querySelectorAll('details[data-key]')) if (openState.has(d.dataset.key)) d.open = openState.get(d.dataset.key);
  hydrate(el);
  autoTriage(items);
  if (atBottom || forceScroll || el.dataset.agent !== selectedId) el.scrollTop = el.scrollHeight;
  forceScroll = false;
  el.dataset.agent = selectedId;
}

async function pollScreen() {
  const a = selected();
  if (tab !== 'term' || !a || document.hidden) return;
  try {
    const { text } = await api('GET', `/api/agents/${a.id}/screen`);
    if (a.id === selectedId) $('#term').textContent = text || '（表示できる画面がありません）';
  } catch {}
}

// ---------- 操作 ----------

function select(id) {
  if (!id) return;
  selectedId = id;
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

function setTab(t) {
  tab = t;
  save('tab', t);
  renderDetail();
  if (t === 'term') pollScreen();
  else loadTranscript();
}

/** 今すぐ送るかキューに積むにゃ。ダイアログ表示中はサーバが送信を拒否するにゃ */
async function sendOrQueue(a, text, mode, clearFirst = false) {
  if (!a) throw new Error('エージェントが選択されていません');
  if (mode === 'queue') return api('POST', `/api/agents/${a.id}/queue`, { op: 'add', text, clearFirst });
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
  const li = e.target.closest('.agent');
  if (li) select(li.dataset.id);
});
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
for (const b of document.querySelectorAll('[data-key]')) b.addEventListener('click', () => sendKey(b.dataset.key));

$('#btn-send').addEventListener('click', () => submit('now'));
$('#btn-queue').addEventListener('click', () => submit('queue'));
$('#input').addEventListener('keydown', (e) => {
  // IME 変換確定の Enter では送信しないにゃ
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    submit(e.ctrlKey || e.metaKey ? 'queue' : 'now');
  }
});
$('#chat').addEventListener('click', (e) => {
  const b = e.target.closest('.triage-btn');
  if (b) openTriageFor(chatItems[Number(b.dataset.idx)], false);
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
    await api('DELETE', `/api/agents/${a.id}`);
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
    // 起動直後は信頼確認などが出ることがあるのでターミナルを見せるにゃ
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

document.addEventListener('keydown', (e) => {
  if ($('#dlg-new').open || !e.altKey) return;
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

// ステータス行の帯と空画面の猫を用意するにゃ
$('#d-cat').innerHTML = catCanvas({ seed: '', state: 'idle', w: 64, h: 16, scale: 2 });
$('#empty-cat').innerHTML = catCanvas({ seed: 'hub', coat: 'orange', state: 'idle', since: 1, scale: 4 });
mountCats($('#empty'));

renderDetail();
connect();
