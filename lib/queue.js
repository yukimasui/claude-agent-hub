// 送信ガードとタスクキューの操作です。
// エージェントの状態だけを見て判断する処理をサーバから切り離し、tmux や Store なしで単体テストできるようにしています。
// tmux への送信・Store への反映・自動送信の起動といった副作用は、呼び出し側（server.js）が行います。
import { randomBytes } from 'node:crypto';
// 画面用のモジュールですが、DOM に触れない抽出処理だけを使うため Node からも読み込めます
import { findOpenProposals, proposalKey } from '../public/triage.js';
// 古い判断による一時停止の理由は、画面も判定に使うため public/queue.js で定義しています
import { STALE_REPLY_ANSWERED_NOTE, STALE_REPLY_NEW_PROPOSAL_NOTE, STALE_REPLY_NOTES } from '../public/queue.js';
import { isHandoffActive } from '../public/handoff.js';

export const MAX_QUEUE = 50;
// キューの一時停止の理由です。理由は queueNote にだけ残しているため、どの理由で止まったかはこの文言で見分けます。
// 各所に文言を直接書くと食い違って判別を誤るおそれがあるので、一時停止するときは必ずこれらの定数を使ってください。
// 提案による一時停止は、判断の追加で自動的に解除するために見分けています（applyQueueOp の add）
export const PROPOSAL_PAUSE_NOTE = '判断待ちの提案があるため一時停止しました';
// 利用者が画面の「一時停止」を押したとき
export const MANUAL_PAUSE_NOTE = '手動で一時停止中';
// 実行中に Esc / Ctrl+C で中断したとき（server.js）
export const INTERRUPT_PAUSE_NOTE = '中断したため一時停止しました';
// StopFailure（API エラーなど）で応答が止まったとき（lib/store.js）
export const ERROR_PAUSE_NOTE = 'エラーで停止したため一時停止しました';
// 「引き継いでリセット」の実行中（server.js）。終了時に元の状態へ戻すかどうかを、この文言のままかで見分けます（lib/handoff.js の queueRestoreFields）
export const HANDOFF_PAUSE_NOTE = '引き継いでリセットの実行中のため一時停止しています';
// 先頭の判断が、送る時点で判断待ちの提案に対応しなくなったとき（proposalPauseNote）。
// 古い判断を別の提案への返答として送らないよう止め、利用者が内容を確かめてから、送るか削除するかを選んで再開できるようにします
// （applyQueueOp の resume の staleReply）。編集してから送ることもできます。
// 文言は public/queue.js で定義し、ほかの理由と同じくこのモジュールからも使えるよう再公開しています
export { STALE_REPLY_ANSWERED_NOTE, STALE_REPLY_NEW_PROPOSAL_NOTE };
// 対象の提案の識別子（proposalKey の値）として受け付ける長さの上限です。想定外に大きな値を agents.json に残さないためです
const MAX_PROPOSAL_KEY = 200;

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status }, code ? { code } : {});
}

/** tmux に文字を流し込むと誤入力になる状況なら、その理由を返します（送信してよければ null） */
export function sendBlockReason(a) {
  if (!a.alive) return 'エージェントは停止しています。';
  if (a.pending.length) return '回答待ちのダイアログがあります。先にダイアログへ回答するか、キューに追加してください。';
  if (a.state === 'waiting') return 'ターミナルでダイアログが表示されています。ターミナルタブで確認するか、キューに追加してください。';
  if (a.state === 'starting') return '起動中です（信頼確認などのダイアログが表示されている可能性があります）。ターミナルタブで確認してください。';
  // 引き継ぎの途中に別の指示が入ると、メモの取り出しや新しいセッションの最初の指示が崩れるため、終わるまで送らせません
  if (isHandoffActive(a.handoff)) return '「引き継いでリセット」の実行中です。完了するまでお待ちください。';
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
  // 引き継ぎの間は、キューが送られないよう一時停止を保ちます。終了時に引き継ぎ前の状態へ戻すため、一時停止の切り替えと送信は受け付けません
  if (isHandoffActive(a.handoff) && (body.op === 'pause' || body.op === 'resume' || body.op === 'sendNext')) {
    throw httpError(409, '「引き継いでリセット」の実行中は、キューの一時停止・再開・送信はできません。完了後に元の状態に戻ります。');
  }
  switch (body.op) {
    case 'add': {
      const text = String(body.text ?? '').trim();
      if (!text) throw httpError(400, 'キューに追加する内容が空です');
      if (q.length >= MAX_QUEUE) throw httpError(400, `キューは ${MAX_QUEUE} 件までです`);
      const item = { id: randomBytes(4).toString('hex'), text, clearFirst: !!body.clearFirst, createdAt: Date.now() };
      // body.reply は仕分けボードからの提案への判断です。
      // 判断の前に無関係な指示が届くと提案への返答にならないため、ほかの項目より先に入れます。
      if (body.reply) {
        item.reply = true;
        // どの提案への判断かを記録し、送る前に判断待ちの提案と照合します（proposalPauseNote）。
        // 記録がない判断は、照合せずにこれまでどおり送ります
        if (typeof body.proposal === 'string' && body.proposal && body.proposal.length <= MAX_PROPOSAL_KEY) item.proposal = body.proposal;
      }
      body.front || body.reply ? q.unshift(item) : q.push(item);
      // 提案のために止まっていた場合は、その返答が届いたので一時停止を解除し、手動の操作なしに判断から送られるようにします。
      // 古い判断のために止まっていた場合も、新しい判断がその前に入るので解除します。古い判断は後ろに残り、順番が来たときに改めて照合されます。
      // 手動や中断による一時停止は利用者の意図なので残します（「再開」の 1 回で判断から送られます）
      if (body.reply && a.queuePaused && (a.queueNote === PROPOSAL_PAUSE_NOTE || STALE_REPLY_NOTES.has(a.queueNote))) {
        Object.assign(patch, { queuePaused: false, queueNote: '' });
      }
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
      Object.assign(patch, { queuePaused: true, queueNote: MANUAL_PAUSE_NOTE });
      break;
    case 'resume': {
      // body.staleReply は、古い判断の扱いを利用者が明示的に選んだことを示します（画面の「古い判断を送って再開」「古い判断を削除して再開」）。
      // 'send' は判断から対象の記録を外し、照合せずにそのまま送ります。'drop' は判断を削除して、続く項目から送ります。
      // どちらも body.itemId で項目を指定させ、画面を開いた後にキューが変わっていても、利用者が見ていた判断だけを扱うようにしています。
      // 指定がない「再開」は一時停止を解くだけで、判断の記録は残します。次の自動送信の前に、その時点の会話で改めて照合し、
      // まだ古ければ最新の理由で再び一時停止し、判断待ちの提案に対応していればそのまま送ります（proposalPauseNote）。
      // 後ろの項目を進めるつもりで押した「再開」で、古い判断が意図せず送られないようにするためです
      if (body.staleReply != null) {
        if (body.staleReply !== 'send' && body.staleReply !== 'drop') throw httpError(400, `不明な指定です: ${body.staleReply}`);
        const i = find();
        if (!q[i].reply) throw httpError(400, '提案への判断ではない項目です');
        if (body.staleReply === 'drop') q.splice(i, 1);
        else {
          const { proposal, ...rest } = q[i];
          q[i] = rest;
        }
      }
      Object.assign(patch, { queuePaused: false, queueNote: '' });
      break;
    }
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
 * キューの自動送信を、提案に関わる理由で一時停止すべきなら、その理由（queueNote に入れる文言）を返します（送ってよければ null）。
 * - 先頭が判断以外で、判断待ちの提案があるとき: PROPOSAL_PAUSE_NOTE（提案への返答より先に無関係な指示が届かないようにします）
 * - 先頭が判断で、対象の提案がまだ判断待ちのとき: null（それを送ることが返答になるので止めません）
 * - 先頭が判断で、判断待ちの提案が対象と別のとき: STALE_REPLY_NEW_PROPOSAL_NOTE（新しい提案への返答として送られるのを防ぎます）
 * - 先頭が判断で、判断待ちの提案がないとき: STALE_REPLY_ANSWERED_NOTE（ターミナルなどで返答済みの提案に重ねて送るのを防ぎます）
 * 対象の提案の記録がない判断（記録を始める前にキューに入ったものや、利用者が「古い判断を送って再開」で送ると決めたもの）は照合せずに送ります。
 * 判断待ちの提案の判定は、画面の仕分けボードと同じ findOpenProposals と proposalKey で行います。
 * 判断を送った後は利用者の発言が提案の後に続くため、判断待ちの提案がなくなり、続く項目も止まらずに送られます。
 */
export function proposalPauseNote(a, items) {
  const head = a.queue[0];
  const open = findOpenProposals(items);
  if (head?.reply) {
    if (!head.proposal) return null;
    if (!open) return STALE_REPLY_ANSWERED_NOTE;
    return proposalKey(open) === head.proposal ? null : STALE_REPLY_NEW_PROPOSAL_NOTE;
  }
  return open ? PROPOSAL_PAUSE_NOTE : null;
}
