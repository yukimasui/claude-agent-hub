// タスクキューのパネルにゃ。
// 並べ替え（ドラッグ＆ドロップ / ↑↓）、編集、/clear の切り替え、削除、一時停止・再開ができるにゃ
import { esc } from './md.js';

/**
 * キューの項目が仕分けボードからの提案への判断（reply の印付き）であれば、項目に付ける目印を返します（判断でなければ null）。
 * openKey は判断待ちの提案の proposalKey で、判断待ちの提案がなければ null、会話をまだ読み込んでいないなどで分からないときは undefined を渡します。
 * 対象の提案がもう判断待ちでない判断は stale にします。基準はサーバが先頭の判断を送る前に照合する処理（lib/queue.js の proposalPauseNote）と同じで、
 * 順番が来ると送らずに一時停止する項目を、並べ替えや削除の前に見分けられるようにするためです。
 * 分からないときや、対象の記録がない判断（記録を始める前に入ったものや「古い判断を送って再開」で送ると決めたもの）は、照合されずに送られるので stale にしません。
 * テストできるよう DOM には触れません。
 * @returns {{ stale: boolean, label: string, title: string } | null}
 */
export function replyMark(item, openKey) {
  if (!item?.reply) return null;
  if (item.proposal && openKey !== undefined && openKey !== item.proposal) {
    const why = openKey ? '判断をキューに入れた後に新しい提案が出ています' : '対象の提案にはすでに返答があります';
    return {
      stale: true,
      label: '古い判断',
      title: `提案への判断ですが、対象の提案はもう判断待ちではありません（${why}）。順番が来ると、別の提案への返答として送られないよう、送らずにキューを一時停止します。不要であれば削除してください。`,
    };
  }
  return {
    stale: false,
    label: '提案への判断',
    title:
      '仕分けボードで作成した提案への判断です。キューの先頭にある間は、判断待ちの提案があっても一時停止せずに送信します。ほかの項目をこの判断より前に移すと、提案への返答より先に無関係な指示が届かないよう、キューが一時停止することがあります。',
  };
}

/**
 * 一時停止中のキューの先頭が古い判断（replyMark が stale）なら、その項目を返します（そうでなければ null）。
 * このときは「再開」の代わりに「古い判断を送って再開」「古い判断を削除して再開」を出し、古い判断の扱いを利用者に選んでもらいます。
 * 単なる「再開」では、送る前の照合で再び一時停止するだけになり、操作の結果が分かりにくいためです。
 * 古いかどうかが分からないとき（openKey が undefined）は null を返し、通常の「再開」を出します。サーバが送る前に照合し、古ければ再び一時停止します。
 * テストできるよう DOM には触れません。
 */
export function staleHead(agent, openKey) {
  const head = agent.queue?.[0];
  return agent.queuePaused && replyMark(head, openKey)?.stale ? head : null;
}

/** 見出しの一時停止・再開のボタンです */
function resumeButtons(agent, openKey) {
  if (!agent.queuePaused) return '<button type="button" data-op="pause">一時停止</button>';
  const stale = staleHead(agent, openKey);
  if (!stale) return '<button type="button" data-op="resume" class="primary">再開</button>';
  const id = esc(stale.id);
  return `<button type="button" data-op="resumeDrop" data-item="${id}" title="先頭の古い判断をキューから削除し、続く項目から送信を再開します">古い判断を削除して再開</button>
      <button type="button" data-op="resumeSend" data-item="${id}" title="先頭の古い判断を、今の会話にそのまま送信してから続く項目を送信します">古い判断を送って再開</button>`;
}

/**
 * root にキューを描画するにゃ。
 * op(body) はサーバの queue 操作を呼ぶ関数（Promise）にゃ
 * openKey は判断待ちの提案の proposalKey です（replyMark を参照してください）
 */
export function renderQueue(root, agent, op, openKey) {
  const q = agent.queue || [];
  if (!q.length) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  const busy = agent.state === 'running' || agent.state === 'compacting' || agent.state === 'waiting';
  const status = agent.queuePaused
    ? `<span class="q-status paused">一時停止中${agent.queueNote ? `：${esc(agent.queueNote)}` : ''}</span>`
    : `<span class="q-status">${busy ? '現在の作業が終わると、先頭から自動で送信します' : '待機中のため、まもなく送信します'}</span>`;
  root.hidden = false;
  root.innerHTML = `<header class="queue-head">
      <b>キュー</b><span class="muted">${q.length}件</span>
      ${status}
      ${resumeButtons(agent, openKey)}
      <button type="button" data-op="sendNext" ${q.length ? '' : 'disabled'} title="一時停止中でも先頭の 1 件だけを送信します">先頭を今すぐ送信</button>
    </header>
    <ol class="queue-list">
      ${q
        .map((it, i) => {
          const mark = replyMark(it, openKey);
          // 目印は本文（.qi-text）の外に置きます。本文は編集の開始・終了で中身を差し替えるため、中に置くと目印が消えるためです
          return `<li class="queue-item${mark ? (mark.stale ? ' reply stale' : ' reply') : ''}" draggable="true" data-id="${esc(it.id)}">
          <span class="grip" title="ドラッグで並べ替え">⋮⋮</span>
          <span class="qi-num">${i + 1}</span>
          <div class="qi-main">${mark ? `<span class="qi-mark" title="${esc(mark.title)}">${esc(mark.label)}</span>` : ''}<div class="qi-text" title="ダブルクリックで編集">${esc(it.text)}</div></div>
          <label class="inline-check qi-clear" title="送信前に /clear で会話をリセットします"><input type="checkbox" data-op="toggleClear" ${it.clearFirst ? 'checked' : ''}> /clear</label>
          <button type="button" class="icon" data-op="up" title="上へ" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="icon" data-op="down" title="下へ" ${i === q.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="icon" data-op="edit" title="編集">✎</button>
          <button type="button" class="icon danger" data-op="remove" title="削除">✕</button>
        </li>`;
        })
        .join('')}
    </ol>`;

  const ids = () => [...root.querySelectorAll('.queue-item')].map((li) => li.dataset.id);
  const reorder = (list) => op({ op: 'reorder', ids: list });

  const startEdit = (li) => {
    const it = q.find((x) => x.id === li.dataset.id);
    const box = li.querySelector('.qi-text');
    if (!it || box.querySelector('textarea')) return;
    box.innerHTML = `<textarea rows="3">${esc(it.text)}</textarea><div class="muted">Enter で保存、Shift+Enter で改行、Esc で取り消し</div>`;
    li.draggable = false;
    const ta = box.querySelector('textarea');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      li.draggable = true;
      if (save && ta.value.trim() && ta.value !== it.text) op({ op: 'update', itemId: it.id, text: ta.value });
      else box.textContent = it.text;
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') finish(false);
    });
    ta.addEventListener('blur', () => finish(true));
  };

  root.onclick = (e) => {
    const b = e.target.closest('button[data-op]');
    if (!b) return;
    const li = b.closest('.queue-item');
    const id = li?.dataset.id;
    const list = ids();
    const i = list.indexOf(id);
    switch (b.dataset.op) {
      case 'pause':
      case 'resume':
      case 'sendNext':
        return op({ op: b.dataset.op });
      case 'resumeSend':
      case 'resumeDrop':
        // 描画した時点の先頭の項目を指定し、その後にキューが変わっていても、利用者が見ていた判断だけを扱います
        return op({ op: 'resume', staleReply: b.dataset.op === 'resumeSend' ? 'send' : 'drop', itemId: b.dataset.item });
      case 'remove':
        return op({ op: 'remove', itemId: id });
      case 'edit':
        return startEdit(li);
      case 'up':
        [list[i - 1], list[i]] = [list[i], list[i - 1]];
        return reorder(list);
      case 'down':
        [list[i + 1], list[i]] = [list[i], list[i + 1]];
        return reorder(list);
    }
  };
  root.onchange = (e) => {
    if (e.target.dataset.op === 'toggleClear') op({ op: 'update', itemId: e.target.closest('.queue-item').dataset.id, clearFirst: e.target.checked });
  };
  root.ondblclick = (e) => {
    const li = e.target.closest('.queue-item');
    if (li && e.target.closest('.qi-text')) startEdit(li);
  };

  // ドラッグで並べ替えるにゃ
  let dragId = null;
  root.ondragstart = (e) => {
    const li = e.target.closest?.('.queue-item');
    if (!li) return;
    dragId = li.dataset.id;
    e.dataTransfer.setData('text/plain', dragId);
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
  };
  root.ondragover = (e) => {
    const li = e.target.closest?.('.queue-item');
    if (!li || !dragId) return;
    e.preventDefault();
    const dragging = root.querySelector('.queue-item.dragging');
    if (!dragging || dragging === li) return;
    const rect = li.getBoundingClientRect();
    li.parentNode.insertBefore(dragging, e.clientY < rect.top + rect.height / 2 ? li : li.nextSibling);
  };
  root.ondragend = () => {
    const dragging = root.querySelector('.queue-item.dragging');
    dragging?.classList.remove('dragging');
    if (!dragId) return;
    dragId = null;
    const list = ids();
    if (list.join() !== q.map((x) => x.id).join()) reorder(list);
  };
  root.ondrop = (e) => e.preventDefault();
}
