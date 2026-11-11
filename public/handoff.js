// コンテキスト量の表示と「引き継いでリセット」の、画面とサーバの両方で使う判定です。
// 実行できるかどうかの判定（handoffBlockReason）を画面とサーバで食い違わせないよう、DOM に触れない関数だけをここに置き、
// サーバ（lib/queue.js・server.js）からも読み込みます。

// 「引き継いでリセット」の段階です。memo（引き継ぎメモの作成を指示して応答を待つ）→ clear（/clear を送って新しいセッションを待つ）の順に進み、
// 新しいセッションが始まったら再開の指示を送って done（完了）になります。途中で止めた場合は failed（中止）です
export const HANDOFF_ACTIVE_STAGES = new Set(['memo', 'clear']);

/** 引き継ぎが進行中か（完了・中止の結果を表示しているだけではないか）を返します */
export function isHandoffActive(handoff) {
  return !!handoff && HANDOFF_ACTIVE_STAGES.has(handoff.stage);
}

/**
 * 「引き継いでリセット」を始められない理由を返します（始めてよければ null）。
 * 応答が終わっていない間や回答待ちの要求がある間に指示を送ると、作業の途中に割り込んだり、ダイアログへの誤入力になったりするため、
 * 状態が「応答完了」か「待機中」で、回答待ちの要求がないときだけ始められるようにします。
 * メモはエージェントの応答として transcript から取り出すので、会話の記録がまだない場合も始めません。
 */
export function handoffBlockReason(a) {
  if (!a) return 'エージェントが選択されていません';
  if (isHandoffActive(a.handoff)) return '引き継いでリセットを実行中です';
  if (!a.alive) return 'エージェントは停止しています';
  if (a.pending?.length) return '回答待ちの要求があります。先に回答してください';
  if (a.state !== 'done' && a.state !== 'idle') return '状態が「応答完了」か「待機中」のときに実行できます';
  if (!a.transcriptPath) return 'まだ会話がありません';
  return null;
}

const STAGE_LABEL = {
  memo: '1/3 引き継ぎメモを作成しています',
  clear: '2/3 /clear して新しいセッションを待っています',
  done: '引き継ぎが完了しました',
  failed: '引き継ぎを中止しました',
};

/** 画面に出す段階の表示です（引き継ぎの記録がなければ空文字） */
export function handoffStageLabel(handoff) {
  if (!handoff) return '';
  return STAGE_LABEL[handoff.stage] || handoff.stage;
}

/**
 * コンテキスト量を短い表記にします（例: 8,500 → "ctx 8,500"、123,456 → "ctx 12.3万"）。量が分からないときは空文字です。
 * 一覧のカードは幅が狭いため、1 万以上は万の単位で小数 1 桁までにしています。
 */
export function formatContext(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens < 10000) return `ctx ${Math.round(tokens).toLocaleString('ja-JP')}`;
  const man = tokens / 10000;
  return `ctx ${man >= 100 ? Math.round(man) : man.toFixed(1)}万`;
}

/** コンテキスト量が目安を超えているか（「切り替え推奨」の目印を出すか）を返します */
export function contextOver(tokens, limit) {
  return Number.isFinite(tokens) && Number.isFinite(limit) && limit > 0 && tokens > limit;
}

/** 目印やステータス行に添える説明です */
export function contextTitle(tokens, limit) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  const base = `コンテキスト量: ${Math.round(tokens).toLocaleString('ja-JP')} トークン（最新の応答の入力量）`;
  if (!Number.isFinite(limit) || limit <= 0) return base;
  const lim = limit.toLocaleString('ja-JP');
  return contextOver(tokens, limit)
    ? `${base}。目安の ${lim} を超えています。「引き継いでリセット」で新しいセッションに切り替えることをおすすめします`
    : `${base}。目安は ${lim} です`;
}
