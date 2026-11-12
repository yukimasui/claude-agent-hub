// 詳細のヘッダーの「終了」（動いているエージェントに /exit を送る操作）の、画面とサーバの両方で使う判定です。
// 終了を送れるかどうかを画面とサーバで食い違わせないよう、DOM に触れない関数だけをここに置き、サーバ（server.js・lib/queue.js）からも読み込みます。
import { isHandoffActive } from './handoff.js';

// Claude Code を終了させるコマンドです。プロンプトに入力して実行すると、SessionEnd の後にプロセスが終わります
export const EXIT_COMMAND = '/exit';

// 終了を送ってから、プロセスが終わる（生存確認で「終了」になる）までの間の理由です。
// 二重に送ったり、終わりかけのプロセスに別の入力を送ったりしないよう、送信ガード（lib/queue.js の sendBlockReason）でも使います
export const EXITING_REASON = '終了を指示しています。プロセスが終わるまでお待ちください。';

/**
 * 動いているエージェントに終了（/exit）を送れない理由を返します（送ってよければ null）。
 * /exit はプロンプトに入力して送るため、入力が別の場所に入る状態（回答待ちのダイアログ、ターミナルのダイアログ、起動中の信頼確認など）では送りません。
 * 実行中や圧縮中も送りません。Claude Code の入力キューに入って作業の後に実行されるなど、いつ終わるかが読めないためで、
 * 先に中断してから終了してもらいます。「引き継いでリセット」の実行中も、メモの取り出しや新しいセッションの指示が崩れるため送りません。
 * キューの送信中・起動し直しの最中といったサーバだけが知っている状態は、呼び出し側（server.js の exitAgent）が確かめます。
 */
export function exitBlockReason(a) {
  if (!a) return 'エージェントが選択されていません';
  if (!a.alive) return 'エージェントは停止しています。';
  if (a.exitSentAt) return EXITING_REASON;
  if (isHandoffActive(a.handoff)) return '「引き継いでリセット」の実行中です。完了するまでお待ちください。';
  if (a.pending?.length) return '回答待ちのダイアログがあります。先にダイアログへ回答してください。';
  if (a.state === 'waiting') return 'ターミナルでダイアログが表示されています。ターミナルタブで確認してください。';
  if (a.state === 'starting') return '起動中です（信頼確認などのダイアログが表示されている可能性があります）。ターミナルタブで確認してください。';
  if (a.state === 'running' || a.state === 'compacting') return '作業中です。中断（Esc）してから終了してください。';
  if (a.state !== 'done' && a.state !== 'idle') return '状態が「応答完了」か「待機中」のときに終了できます。';
  return null;
}
