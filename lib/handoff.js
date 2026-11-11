// 「引き継いでリセット」の段階の進め方を決める処理です。
// エージェントの状態と transcript だけを見て次の操作を返し、tmux への送信・Store への反映・メモの保存は server.js が行います。
// 判定を副作用から切り離しているのは、単体テストで確かめられるようにするためと、
// サーバが再起動しても、保存した段階（agents.json の handoff）と復元した状態から同じ判定で続きを進められるようにするためです。
import { isHandoffActive } from '../public/handoff.js';
import { HANDOFF_PAUSE_NOTE } from './queue.js';

// メモの応答を待つ時間の上限です。長い会話では応答に時間がかかるため長めにしています
export const MEMO_TIMEOUT_MS = 15 * 60 * 1000;
// 応答完了（Stop）の後、transcript にメモが書き込まれるのを待つ時間です。Stop と transcript の書き込みの順序に頼らないためです
export const MEMO_GRACE_MS = 5000;
// /clear を送ってから新しいセッションが始まるのを待つ時間の上限です
export const CLEAR_TIMEOUT_MS = 60 * 1000;

const NOT_CLEARED = '/clear は送っていません';

/**
 * 引き継ぎメモを書かせる指示です。marker は、transcript からこの指示を見つけるための識別子です。
 * メモは ```handoff のブロックに書かせ、前置きの文などとメモの本文を分けて取り出せるようにします。
 * ファイルに書かせないのは、作業ディレクトリに引き継ぎのためのファイルを残さないためです（メモはハブが保存します）。
 */
export function buildMemoPrompt(marker) {
  return `（Agent Hub「引き継いでリセット」: ${marker}）
この後、会話をリセット（/clear）して新しいセッションで作業を続けます。新しいセッションでは今までの会話を読めないため、続きから再開できるよう引き継ぎメモを書いてください。

- ツールは使わず、この応答の本文として書いてください（ファイルには書かないでください）
- メモは \`\`\`handoff で始まるコードブロックの中に Markdown で書いてください。メモの中でコードを示す場合は ~~~ で囲んでください
- 次の項目を含めてください: 進行中の作業と現在の状況 / 決定事項とその理由 / 未解決の点・注意点 / 次にやること / 関係するファイル・Issue・PR・コマンドなど
- メモだけを読んで作業を再開できるよう、具体的に書いてください`;
}

/** 新しいセッションの最初の指示です。メモの保存先も添え、必要なら後から読み返せることを伝えます */
export function buildResumePrompt(memo, file) {
  return `前のセッションからの引き継ぎです。次の引き継ぎメモを読んで、続きから作業を再開してください。
（Agent Hub の「引き継いでリセット」で作成したメモです。保存先: ${file}）

${memo}`;
}

const FENCE_OPEN_RE = /^```handoff[^\S\n]*\n/m;

/**
 * 応答の本文から ```handoff のブロックの中身を取り出します（ブロックがなければ null）。
 * メモの中に ``` のコードブロックが書かれても途中で切れないよう、ブロックの終わりは本文の最後の ``` の行にします。
 * 閉じていないブロック（応答が途中で終わった場合など）は本文の終わりまでをメモにします。
 */
export function handoffBlock(text) {
  if (typeof text !== 'string') return null;
  const m = FENCE_OPEN_RE.exec(text);
  if (!m) return null;
  const body = text.slice(m.index + m[0].length);
  const close = [...body.matchAll(/^```[^\S\n]*$/gm)].at(-1);
  return (close ? body.slice(0, close.index) : body).trim();
}

/**
 * 会話の項目（readTranscript の結果）から、marker を含む指示への応答として書かれた引き継ぎメモを取り出します（取り出せなければ null）。
 * ```handoff のブロックがあればその中身を、なければ指示より後の応答の本文をすべてメモとします。
 * ブロックの形式に従わなかった応答でも、エージェントが書いた内容を引き継げるようにするためです。応答が空なら null です。
 */
export function extractMemo(items, marker) {
  if (!Array.isArray(items) || !marker) return null;
  let start = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === 'user' && typeof items[i].text === 'string' && items[i].text.includes(marker)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const texts = items.slice(start + 1).filter((it) => it.role === 'assistant' && it.text?.trim()).map((it) => it.text);
  for (let i = texts.length - 1; i >= 0; i--) {
    const block = handoffBlock(texts[i]);
    if (block) return block;
  }
  const all = texts.join('\n\n').trim();
  return all || null;
}

/**
 * 段階を次へ進めるために行う操作を返します。
 * - { type: 'none' }: 進行中の引き継ぎはありません
 * - { type: 'wait' }: 条件がそろうまで待ちます（状態の変化と定期的な確認のたびに呼び直します）
 * - { type: 'fail', reason }: 中止します。理由は画面に表示します
 * - { type: 'clear', memo }: メモを保存して /clear を送ります
 * - { type: 'resume' }: 新しいセッションが始まったので、メモを付けた再開の指示を送ります
 * - { type: 'finish', note }: 新しいセッションで指示がすでに始まっているため、送らずに完了にします
 *
 * a.handoff には段階（stage）のほか、指示を送った時刻（sentAt）、元のセッション ID（fromSession）、指示の識別子（marker）、
 * /clear を送った時刻（clearSentAt）を記録しています。readItems は transcript の会話の項目を返す関数で、メモを取り出すときだけ呼びます。
 *
 * /clear を送るのは、メモを取り出せたときだけです。サーバが途中で再起動しても、この判定は保存した段階と、
 * イベント JSONL から復元した状態だけで行うため、メモを保存しないまま /clear だけが送られることはありません。
 */
export function handoffStep(a, { now = Date.now(), readItems = () => [] } = {}) {
  const h = a?.handoff;
  if (!isHandoffActive(h)) return { type: 'none' };
  const fail = (reason) => ({ type: 'fail', reason });
  const saved = h.memoFile ? `メモは ${h.memoFile} に保存しています` : 'メモは保存しています';
  const keep = h.stage === 'memo' ? NOT_CLEARED : saved;
  if (!a.alive) return fail(`エージェントが終了したため中止しました（${keep}）`);
  // 引き継ぎを始めた後にプロセスが起動し直された場合です（ハブからの再起動や、ターミナルでの /resume など）。
  // 再起動はプロセスの終了後に行うため、通常は上の終了の判定で中止になりますが、終了を確かめる前に再起動されることもあります。
  // その後のセッションは送った /clear によるものではないので、セッション ID が変わっていても再開の指示は送りません。
  // 起動時刻は startup / resume の SessionStart から復元するため、ハブのサーバの再起動では変わらず、続きの判定を妨げません
  if (a.processStartedAt != null && a.processStartedAt > h.sentAt) {
    return fail(`引き継ぎの途中でエージェントが再起動されたか、別の会話が再開されたため中止しました（${keep}）`);
  }

  if (h.stage === 'memo') {
    // ターミナルで /clear や /resume をした場合などです。別の会話の応答をメモとして扱わないよう中止します
    if (a.sessionId !== h.fromSession) return fail(`引き継ぎメモの作成中にセッションが切り替わったため中止しました（${NOT_CLEARED}）`);
    if (a.state === 'ended') return fail(`引き継ぎメモの作成中にセッションが終了したため中止しました（${NOT_CLEARED}）`);
    if (a.pending?.length || a.state === 'waiting') return fail(`引き継ぎメモの作成中に確認や質問の回答待ちになったため中止しました（${NOT_CLEARED}）`);
    const after = a.stateSince >= h.sentAt;
    // ハブのキー送信で中断すると「待機中」に戻ります（Stop は届きません）
    if (a.state === 'idle' && after) return fail(`引き継ぎメモの作成が中断されたため中止しました（${NOT_CLEARED}）`);
    if (a.state !== 'done' || !after) {
      return now - h.sentAt > MEMO_TIMEOUT_MS ? fail(`引き継ぎメモの応答が ${MEMO_TIMEOUT_MS / 60000} 分以内に終わらなかったため中止しました（${NOT_CLEARED}）`) : { type: 'wait' };
    }
    const memo = extractMemo(readItems(), h.marker);
    if (memo) return { type: 'clear', memo };
    if (now - a.stateSince < MEMO_GRACE_MS) return { type: 'wait' };
    return fail(`引き継ぎメモを取り出せなかったため中止しました（応答が空です。${NOT_CLEARED}）`);
  }

  // stage === 'clear'。/clear では SessionEnd（終了）に続いて SessionStart が届くため、状態の「終了」では中止せず、プロセスの終了（alive）だけを見ます
  if (a.sessionId === h.fromSession) {
    return now - (h.clearSentAt ?? h.sentAt) > CLEAR_TIMEOUT_MS
      ? fail(`/clear の後に新しいセッションが始まったことを確認できなかったため中止しました（${saved}）`)
      : { type: 'wait' };
  }
  if (a.state === 'idle') return { type: 'resume' };
  // 新しいセッションで指示がすでに始まっている場合です（再開の指示を送った直後にサーバが止まった場合など）。二重に送らないよう完了にします
  if (a.state === 'running' || a.state === 'done' || a.state === 'compacting') {
    return { type: 'finish', note: `新しいセッションで指示がすでに始まっていたため、再開の指示は送りませんでした（${saved}）` };
  }
  return now - (h.clearSentAt ?? h.sentAt) > CLEAR_TIMEOUT_MS ? fail(`新しいセッションで再開の指示を送れる状態にならなかったため中止しました（${saved}）`) : { type: 'wait' };
}

/**
 * 引き継ぎを終えるときに、キューの一時停止を元に戻すフィールドを返します。
 * 引き継ぎの間に別の理由（中断やエラー）で一時停止し直した場合は、その理由を残します。利用者が止めた意図や、止まった理由を消さないためです。
 */
export function queueRestoreFields(a) {
  const h = a.handoff || {};
  if (a.queueNote !== HANDOFF_PAUSE_NOTE) return {};
  return { queuePaused: !!h.prevPaused, queueNote: h.prevPaused ? h.prevNote || '' : '' };
}

// 保存するメモの先頭に置く 1 行の情報です。本文と区別して読み戻せるよう HTML のコメントにしています
const MEMO_HEADER_RE = /^<!-- Agent Hub 引き継ぎメモ[^\n]*-->\n\n?/;

/** 保存するメモファイルの内容です。どのエージェント・セッションのメモかを先頭に記録します */
export function formatMemoFile(meta, memo) {
  const info = [`エージェント: ${meta.name} (${meta.id})`, `作業ディレクトリ: ${meta.cwd}`, `元のセッション: ${meta.sessionId}`, `作成: ${new Date(meta.createdAt).toISOString()}`]
    .join(' / ')
    .replace(/--+>?/g, '-');
  return `<!-- Agent Hub 引き継ぎメモ: ${info} -->\n\n${memo}\n`;
}

/** 保存したメモファイルから本文を取り出します。サーバの再起動後に再開の指示を組み立てるときに使います */
export function parseMemoFile(text) {
  return String(text).replace(MEMO_HEADER_RE, '').trim();
}

/** メモファイルの名前です（エージェント ID と作成時刻）。同じエージェントのメモが時刻の順に並ぶようにしています */
export function memoFileName(id, createdAt) {
  const t = new Date(createdAt).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `${id}-${t}.md`;
}
