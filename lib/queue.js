// 送信ガードとタスクキューの操作です。
// エージェントの状態だけを見て判断する処理をサーバから切り離し、tmux や Store なしで単体テストできるようにしています。
// tmux への送信・Store への反映・自動送信の起動といった副作用は、呼び出し側（server.js）が行います。
import { randomBytes } from 'node:crypto';
// 画面用のモジュールですが、DOM に触れない抽出処理だけを使うため Node からも読み込めます
import { findOpenProposals } from '../public/triage.js';

export const MAX_QUEUE = 50;
// 一時停止の理由は queueNote にだけ残しているため、提案による一時停止かどうかはこの文言で見分けます
export const PROPOSAL_PAUSE_NOTE = '判断待ちの提案があるため一時停止しました';

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status }, code ? { code } : {});
}

/** tmux に文字を流し込むと誤入力になる状況なら、その理由を返します（送信してよければ null） */
export function sendBlockReason(a) {
  if (!a.alive) return 'エージェントは停止しています。';
  if (a.pending.length) return '回答待ちのダイアログがあります。先にダイアログへ回答するか、キューに追加してください。';
  if (a.state === 'waiting') return 'ターミナルでダイアログが表示されています。ターミナルタブで確認するか、キューに追加してください。';
  if (a.state === 'starting') return '起動中です（信頼確認などのダイアログが表示されている可能性があります）。ターミナルタブで確認してください。';
  return null;
}

/**
 * キューへの操作（body.op）を受け付け、エージェントに反映するフィールドを返します。
 * a.queue は書き換えず、新しい配列を fields.queue として返します。
 * sendNext が true のときは、呼び出し側が fields を反映したうえで先頭の項目を送信します。
 * 受け付けられない操作は status（と送信ガードによる拒否では code: 'blocked'）付きの Error を投げます。
 * @returns {{ fields: object, sendNext: boolean }}
 */
export function applyQueueOp(a, body) {
  const q = [...a.queue];
  const find = () => {
    const i = q.findIndex((x) => x.id === body.itemId);
    if (i < 0) throw httpError(404, 'キューの項目が見つかりません');
    return i;
  };
  const patch = {};
  switch (body.op) {
    case 'add': {
      const text = String(body.text ?? '').trim();
      if (!text) throw httpError(400, 'キューに追加する内容が空です');
      if (q.length >= MAX_QUEUE) throw httpError(400, `キューは ${MAX_QUEUE} 件までです`);
      const item = { id: randomBytes(4).toString('hex'), text, clearFirst: !!body.clearFirst, createdAt: Date.now() };
      // body.reply は仕分けボードからの提案への判断です。
      // 判断の前に無関係な指示が届くと提案への返答にならないため、ほかの項目より先に入れます。
      if (body.reply) item.reply = true;
      body.front || body.reply ? q.unshift(item) : q.push(item);
      // 提案のために止まっていた場合は、その返答が届いたので一時停止を解除し、手動の操作なしに判断から送られるようにします。
      // 手動や中断による一時停止は利用者の意図なので残します（「再開」の 1 回で判断から送られます）
      if (body.reply && a.queuePaused && a.queueNote === PROPOSAL_PAUSE_NOTE) Object.assign(patch, { queuePaused: false, queueNote: '' });
      break;
    }
    case 'update': {
      const i = find();
      const text = body.text != null ? String(body.text).trim() : q[i].text;
      if (!text) throw httpError(400, '内容が空です');
      q[i] = { ...q[i], text, ...(body.clearFirst != null ? { clearFirst: !!body.clearFirst } : {}) };
      break;
    }
    case 'remove':
      q.splice(find(), 1);
      break;
    case 'reorder': {
      // 画面の表示とずれていても項目を失わないよう、指定に含まれない項目は元の順で末尾に残します
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const byId = new Map(q.map((x) => [x.id, x]));
      const next = ids.map((id) => byId.get(id)).filter(Boolean);
      for (const x of q) if (!next.includes(x)) next.push(x);
      q.splice(0, q.length, ...next);
      break;
    }
    case 'pause':
      Object.assign(patch, { queuePaused: true, queueNote: '手動で一時停止中' });
      break;
    case 'resume':
      Object.assign(patch, { queuePaused: false, queueNote: '' });
      break;
    case 'sendNext': {
      // 利用者が明示的に求めた送信なので、一時停止中でも先頭の 1 件だけは送ります
      if (!q.length) throw httpError(400, 'キューが空です');
      const blocked = sendBlockReason(a);
      if (blocked) throw httpError(409, blocked, 'blocked');
      if (a.state === 'running' || a.state === 'compacting') throw httpError(409, 'エージェントが作業中です。完了後に送信されます。');
      return { fields: { queue: q }, sendNext: true };
    }
    default:
      throw httpError(400, `不明な操作です: ${body.op}`);
  }
  return { fields: { queue: q, ...patch }, sendNext: false };
}

/**
 * 会話の項目（readTranscript の結果）の末尾に、まだ返答していない提案（proposals ブロック）があるかを調べます。
 * 判定は画面の仕分けボードと同じ public/triage.js の findOpenProposals に任せます。
 * 基準が食い違うと、仕分けボードが出ないのにキューだけが止まり、利用者が対処できなくなるためです。
 */
export function hasOpenProposals(items) {
  return !!findOpenProposals(items);
}

/**
 * キューの自動送信を、判断待ちの提案のために一時停止すべきかを返します。
 * 先頭が提案への判断（reply の印が付いた項目）なら、それを送ることが返答になるので止めません。
 * 判断を送った後は利用者の発言が提案の後に続くため、hasOpenProposals が偽になり、続く項目も止まらずに送られます。
 */
export function shouldPauseForProposals(a, items) {
  if (a.queue[0]?.reply) return false;
  return hasOpenProposals(items);
}
