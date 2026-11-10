// タスクキューのパネルにゃ。
// 並べ替え（ドラッグ＆ドロップ / ↑↓）、編集、/clear の切り替え、削除、一時停止・再開ができるにゃ
import { esc } from './md.js';

/**
 * root にキューを描画するにゃ。
 * op(body) はサーバの queue 操作を呼ぶ関数（Promise）にゃ
 */
export function renderQueue(root, agent, op) {
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
      <span class="spacer"></span>
      ${agent.queuePaused ? '<button type="button" data-op="resume" class="primary">再開</button>' : '<button type="button" data-op="pause">一時停止</button>'}
      <button type="button" data-op="sendNext" ${q.length ? '' : 'disabled'} title="一時停止中でも先頭の 1 件だけを送信します">先頭を今すぐ送信</button>
    </header>
    <ol class="queue-list">
      ${q
        .map(
          (it, i) => `<li class="queue-item" draggable="true" data-id="${esc(it.id)}">
          <span class="grip" title="ドラッグで並べ替え">⋮⋮</span>
          <span class="qi-num">${i + 1}</span>
          <div class="qi-text" title="ダブルクリックで編集">${esc(it.text)}</div>
          <label class="inline-check qi-clear" title="送信前に /clear で会話をリセットします"><input type="checkbox" data-op="toggleClear" ${it.clearFirst ? 'checked' : ''}> /clear</label>
          <button type="button" class="icon" data-op="up" title="上へ" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="icon" data-op="down" title="下へ" ${i === q.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="icon" data-op="edit" title="編集">✎</button>
          <button type="button" class="icon danger" data-op="remove" title="削除">✕</button>
        </li>`,
        )
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
