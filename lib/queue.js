// 送信ガードとタスクキューの操作です。
// エージェントの状態だけを見て判断する処理をサーバから切り離し、tmux や Store なしで単体テストできるようにしています。
// tmux への送信・Store への反映・自動送信の起動といった副作用は、呼び出し側（server.js）が行います。
import { randomBytes } from 'node:crypto';
// 画面用のモジュールですが、DOM に触れない抽出処理だけを使うため Node からも読み込めます
import { findOpenProposals, proposalKey } from '../public/triage.js';
// 古い判断による一時停止の理由は、画面も判定に使うため public/queue.js で定義しています
import { STALE_REPLY_ANSWERED_NOTE, STALE_REPLY_NEW_PROPOSAL_NOTE, STALE_REPLY_NOTES } from '../public/queue.js';
import { isHandoffActive } from '../public/handoff.js';
import { EXITING_REASON } from '../public/exit.js';

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
// 「/clear 付き」の項目で、/clear を送って待っても新しいセッションを確認できなかったとき（clearPauseNote、server.js の dispatchNext）。
// 項目は送らずに先頭に残します。「再開」（と「先頭を今すぐ送信」）では、同じ項目を /clear の送信からやり直します。
// 先の /clear が遅れて効いていた場合も、もう一度 /clear するのは始まったばかりの空の会話なので害がなく、
// 省くと /clear の効いていない会話に本文を送るおそれがあるためです。/clear せずに送りたい場合は、項目の「/clear」を外してから再開します。
// 仕分けボードからの判断の追加では解除しません（applyQueueOp の add）。TUI が何を受け付けていたかを、利用者がターミナルで確かめてから再開するためです
export const CLEAR_UNCONFIRMED_PAUSE_NOTE = '/clear の完了を確認できなかったため、先頭の項目を送らずに一時停止しました（ターミナルを確認してから再開すると、/clear の送信からやり直します）';
// キューから送ったスラッシュコマンドが、プロンプトとしても、出力を記録するローカルコマンドとしても終わらなかったとき（localCommandPatch）。
// /cost のようにダイアログを開くコマンドは、hook のイベントも transcript の記録も残さず、閉じたことをハブから確かめられません。
// 次の項目がダイアログに入力されないよう、利用者がターミナルで閉じてから再開するまで止めます。
// 仕分けボードからの判断の追加でも解除しません（applyQueueOp の add）。ダイアログが開いたままかもしれないためです
export const LOCAL_COMMAND_PAUSE_NOTE = 'コマンドの終了を確認できなかったため一時停止しました（ダイアログが開いている場合は、ターミナルで閉じてから再開してください）';
// 画面の「終了」で /exit を送ったのに、待ってもプロセスが終わらなかったとき（exitWatchPatch）。
// 終了の確認などのダイアログが開いているかもしれず、次の項目がそこに入力されないよう、利用者がターミナルで確かめてから再開するまで止めます。
// 仕分けボードからの判断の追加でも解除しません（applyQueueOp の add）
export const EXIT_UNCONFIRMED_PAUSE_NOTE = '終了を指示しましたがプロセスが終わらなかったため一時停止しました（ターミナルを確認してから再開してください）';
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
  // 終了を送った後の入力は、終わりかけの TUI に入るだけで届かないため送らせません
  if (a.exitSentAt) return EXITING_REASON;
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
      // 手動や中断による一時停止は利用者の意図なので残します（「再開」の 1 回で判断から送られます）。
      // /clear の完了を確認できなかったことによる一時停止も、利用者がターミナルを確かめるまで残します（CLEAR_UNCONFIRMED_PAUSE_NOTE）
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
 * キューの「/clear 付き」の項目で、送った /clear が終わったか（本文を送ってよいか）を返します。before は /clear を送る前のセッション ID です。
 * /clear では SessionEnd に続いて、新しいセッション ID の SessionStart が届きます。最後のイベントの時刻の変化で判断すると、
 * 先に届く SessionEnd で待つのをやめてしまい、新しいセッションが始まる前に本文を送るおそれがあるため、セッション ID の変化で判断します。
 * エージェントが削除されたか終了した場合は、待っても新しいセッションは始まらないので true を返します（送るかどうかは呼び出し側が確かめ直します）。
 */
export function clearFinished(before, a) {
  return !a || !a.alive || a.sessionId !== before;
}

/**
 * キューの「/clear 付き」の項目で、/clear の完了を待ち終えた後に、本文を送らずに一時停止すべきなら、その理由（queueNote に入れる文言）を返します（送ってよければ null）。
 * before は /clear を送る前のセッション ID です。待っている間にセッション ID が変わらなかった場合は、/clear が効かなかった
 * （TUI が別の入力を受け付けていた、送信が失われたなど）おそれがあり、利用者がリセットしたつもりの会話の続きに本文が届いてしまうため、
 * CLEAR_UNCONFIRMED_PAUSE_NOTE を返して止めます。
 * エージェントが削除されたか終了した場合は null を返します。clearFinished と同じく待つのをやめる条件で、送るかどうかは
 * 呼び出し側が送信直前に確かめ直し、送らずに終えます（一時停止はしません）。
 */
export function clearPauseNote(before, a) {
  if (!a || !a.alive) return null;
  return a.sessionId === before ? CLEAR_UNCONFIRMED_PAUSE_NOTE : null;
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

/**
 * キューの次の項目を自動送信してよい状態かを返します。busy は、そのエージェントでキューの送信中か、起動し直している最中か、終了を送ってプロセスが終わるのを待っている最中かです（server.js の isBusy）。
 * 引き継ぎの間は、一時停止の状態にかかわらず送りません（メモの応答や新しいセッションの最初の指示の前に割り込ませないため）。
 * 起動し直している間も送りません（終了させる前のプロセスや、起動途中のプロセスに送らないため）。
 * 一時停止（queuePaused）は見ません。「先頭を今すぐ送信」では一時停止中でも送るため、呼び出し側（dispatchStartStep など）で判断します。
 */
export function readyForNext(a, { busy = false } = {}) {
  return !!(a && a.alive && a.queue.length && !a.pending.length && (a.state === 'done' || a.state === 'idle') && !busy && !isHandoffActive(a.handoff));
}

/**
 * キューの自動送信（server.js の dispatchNext）で、先頭の項目を送り始める前に何をするかを返します。
 * - { type: 'skip' }: 送らずに終えます（送れる状態でない、または一時停止中で force でない）
 * - { type: 'pause', note }: 送らずに、note を理由として一時停止します（提案に関わる理由。proposalPauseNote）
 * - { type: 'send', item }: 先頭の項目 item を送ります
 * force は「先頭を今すぐ送信」（applyQueueOp の sendNext）で、一時停止と提案に関わる判定を省きます（利用者が送ると決めたものであるため）。
 * readItems は会話の項目（readTranscript の結果）を返す関数で、提案の判定が要るときだけ呼びます。不要な transcript の読み出しを省くためです。
 */
export function dispatchStartStep(a, { force = false, busy = false, readItems }) {
  if (!readyForNext(a, { busy }) || (a.queuePaused && !force)) return { type: 'skip' };
  const note = force ? null : proposalPauseNote(a, readItems());
  if (note) return { type: 'pause', note };
  return { type: 'send', item: a.queue[0] };
}

/**
 * キューの自動送信で、本文を送る直前に何をするかを返します。item は送る項目、before は送り始める前のセッション ID、cur は今のエージェントです。
 * 「/clear 付き」の項目では、/clear を送って完了を待ち終えた後に呼びます。
 * - { type: 'pause', note }: /clear の完了を確認できなかったため、項目を残して一時停止します（clearPauseNote）
 * - { type: 'skip' }: エージェントが削除・終了したか、回答待ちになったため、送らずに終えます（項目は残し、一時停止もしません）
 * - { type: 'send' }: 本文を送ります
 * 一時停止の判定を先にするのは、/clear の後に回答待ちのダイアログが出た場合も、/clear の完了を確認できていないことに変わりはないためです。
 */
export function dispatchSendStep(item, before, cur) {
  const note = item.clearFirst ? clearPauseNote(before, cur) : null;
  if (note) return { type: 'pause', note };
  if (!cur || !cur.alive || cur.pending.length) return { type: 'skip' };
  return { type: 'send' };
}

// キューから送ったスラッシュコマンドが、プロンプトにもローカルコマンドの出力にもならないまま、この時間が過ぎたら一時停止します（localCommandPatch）。
// /context のように出力を記録するまで数秒から 10 秒ほどかかるコマンドがあるため、それより長めにしています。
// 待ちきれずに止めた場合も、利用者が「再開」すれば続きを送れます
export const LOCAL_COMMAND_WAIT_MS = 15000;

/**
 * キューの項目が、TUI の中だけで処理されるローカルコマンド（/cost、/context など）かもしれないかを返します。
 * ローカルコマンドは hook のイベントを出さないため、送った後に「実行中」から戻すきっかけがありません。
 * どのコマンドがローカルかは Claude Code のバージョンや利用者のスキルによって変わり、文字列からは決められないため、
 * スラッシュで始まる項目はすべて送った後の様子を見て判定します（localCommandPatch）。通常のプロンプトは対象にせず、動作を変えません
 */
export function mayBeLocalCommand(text) {
  return /^\/[^\s/]/.test(String(text ?? ''));
}

/**
 * キューからスラッシュコマンドを送った後の見守り（server.js の watchLocalCommand）の情報として妥当な値かを返します。
 * 見守りの情報は agents.json に保存し（localCommandWatch）、ハブを再起動しても続きから見守れるようにしています。
 * 保存したファイルが壊れていた場合などに、時刻のない値で「実行中」へ戻さないよう、読み直すときに確かめます（lib/store.js）
 */
export function isLocalCommandWatch(w) {
  return !!w && typeof w === 'object' && Number.isFinite(w.at) && Number.isFinite(w.stateSince) && Number.isFinite(w.turnStartedAt) && typeof w.command === 'string';
}

/**
 * 見守りの途中で止まったハブを再起動したときに、イベントの読み直し（lib/store.js）で「実行中」へ戻すためのフィールドを返します。
 * 「実行中」はハブが送信の直後に付けたもので、hook のイベントには残らないため、読み直すだけでは送る前の状態（「応答完了」など）に戻ります。
 * そのままでは見守りなしにキューの次の項目が送られ、コマンドが開いたダイアログに入力されるおそれがあるためです。
 * 値は送信の直後と同じにし、localCommandPatch が送信の後に状態が変わったかを、再起動の前と同じ基準で判定できるようにします
 */
export function localCommandRunningFields(w) {
  return { state: 'running', activity: w.activity || `キューから送信: ${w.command}`, stateSince: w.stateSince, turnStartedAt: w.turnStartedAt };
}

/**
 * キューからスラッシュコマンドを送った後に、エージェントへ反映するフィールドを返します。
 * a は現在のエージェント、sent は送信直後の値 { at: 送信を始めた時刻, stateSince, turnStartedAt, sessionId: 「実行中」にしたときの値, command, activity }、
 * outputAt は transcript に記録された最後のローカルコマンドの出力（存在しないコマンドの案内を含みます）の時刻（lib/transcript.js の readLocalCommandOutputAt）、now は現在の時刻です。
 * - hook のイベントで状態が決まった（プロンプトとして展開されて UserPromptSubmit が届いた、/compact や /clear が始まった、
 *   回答待ちになった、ハブから中断した、エージェントが終了した など）: null（何も変えず、以降は通常の状態の流れに任せます）
 * - 送った後にローカルコマンドの出力が記録された: 「待機中」に戻すフィールド（キューは止めずに次の項目へ進みます）
 * - どちらもないまま LOCAL_COMMAND_WAIT_MS が過ぎた: 「待機中」に戻し、LOCAL_COMMAND_PAUSE_NOTE で一時停止するフィールド。
 *   キューが空でも止めます。後から追加した項目が、開いたままのダイアログに入力されないようにするためです
 * - まだ分からない: undefined（呼び出し側は待ち続けます）
 * 表示の文言（activity）は見ません。バックグラウンドのサブエージェントのツール呼び出しでも変わり、ターンの開始とは限らないためです。
 */
export function localCommandPatch(a, sent, outputAt, now) {
  if (!a || !a.alive || a.pending.length) return null;
  if (a.state !== 'running' || a.stateSince !== sent.stateSince || a.turnStartedAt !== sent.turnStartedAt || a.sessionId !== sent.sessionId) return null;
  if (outputAt != null && outputAt >= sent.at) return { state: 'idle', activity: `コマンドを実行しました: ${sent.command}`, stateSince: now };
  if (now - sent.at >= LOCAL_COMMAND_WAIT_MS) {
    return { state: 'idle', activity: `コマンドの終了を確認できませんでした: ${sent.command}`, stateSince: now, queuePaused: true, queueNote: LOCAL_COMMAND_PAUSE_NOTE };
  }
  return undefined;
}

// 画面の「終了」で /exit を送ってから、プロセスが終わるのをこの時間まで待ちます（exitWatchPatch）。
// 通常は数秒で SessionEnd が届き、生存確認（server.js の reconcile、2 秒ごと）で「終了」になるため、それより十分に長くしています
export const EXIT_WAIT_MS = 15000;

/**
 * 画面の「終了」で /exit を送った後（a.exitSentAt が送った時刻）に、エージェントへ反映するフィールドを返します。
 * 送ってから終わるまでの間は、server.js が exitSentAt を「送信中」と同じ扱いにして、キューの自動送信を止めています。
 * - 終了を待っていない: undefined（何もしません）
 * - プロセスが終わった: exitSentAt を外すフィールド（状態は生存確認が「終了」にしています）
 * - EXIT_WAIT_MS を過ぎてもプロセスが残っている: exitSentAt を外します。キューの自動送信が止まったままにならないようにするためです。
 *   SessionEnd が届いている（状態が「終了」）なら、TUI はもう入力を受け付けないので外すだけにします。
 *   それ以外は /exit が効かなかった（終了の確認のダイアログが開いた、入力が失われたなど）おそれがあるため、
 *   EXIT_UNCONFIRMED_PAUSE_NOTE で一時停止して、ダイアログに次の項目が入力されないようにします
 * - まだ分からない: null（待ち続けます）
 */
export function exitWatchPatch(a, now) {
  if (!a?.exitSentAt) return undefined;
  if (!a.alive) return { exitSentAt: null };
  if (now - a.exitSentAt < EXIT_WAIT_MS) return null;
  if (a.state === 'ended') return { exitSentAt: null };
  return { exitSentAt: null, activity: '終了を確認できませんでした。ターミナルを確認してください', queuePaused: true, queueNote: EXIT_UNCONFIRMED_PAUSE_NOTE };
}
