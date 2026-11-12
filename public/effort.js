// エフォート（Claude Code の --effort）の選択肢と、作成後に変更できるかどうかの判定です。
// 変更できるかどうかを画面とサーバで食い違わせないよう、DOM に触れない関数だけをここに置き、サーバ（server.js）からも読み込みます。
import { isHandoffActive } from './handoff.js';

// Claude Code の --effort が受け付ける値です。空文字は「ユーザー設定に従う」で、--effort を付けません
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** 保存値として受け付ける値か（空文字の「ユーザー設定に従う」を含む）を返します */
export function isEffortValue(v) {
  return v === '' || EFFORT_LEVELS.includes(v);
}

/**
 * 作成済みのエージェントのエフォートを変更できない理由を返します（変更してよければ null）。
 * 動いているエージェントの変更は、--resume で起動し直して --effort を付け直すことで反映します（server.js の changeEffort）。
 * ハブから /effort を送らないのは、/effort が利用者の設定（~/.claude/settings.json のモデルごとの既定）にも保存し、
 * ほかのエージェントや新しいセッションの既定まで変えてしまうためです。
 * 起動し直すと作業の途中で止まってしまうため、指示を送ってよい状態（「応答完了」か「待機中」で、回答待ちの要求がない）のときだけ変更できるようにし、
 * サブエージェントが動いている間や「引き継いでリセット」の実行中も変更しません。
 * プロセスが終了しているときは、保存値だけを変えて次の再起動で反映するので、いつでも変更できます。
 */
export function effortChangeBlockReason(a) {
  if (!a) return 'エージェントが選択されていません';
  if (!a.alive) return null;
  if (isHandoffActive(a.handoff)) return '「引き継いでリセット」の実行中です';
  if (a.pending?.length) return '回答待ちの要求があります。先に回答してください';
  if (a.state !== 'done' && a.state !== 'idle') return '状態が「応答完了」か「待機中」のときに変更できます';
  if (a.subagents?.some((s) => s.state === 'running' || s.state === 'waiting')) return 'サブエージェントが動いています。終わってから変更してください';
  return null;
}

/**
 * TUI で実行された /effort の結果（lib/transcript.js の readEffortChange が返す { value, at }）のうち、保存値に反映すべきものなら、
 * 反映する値を返します（反映しなければ undefined）。
 * - 今のプロセスが起動する前（processStartedAt より前）の実行は使いません。起動し直した時点で --effort に置き換わっているためです
 * - ハブから変更した時刻（effortSetAt）以前の実行も使いません。プロセスの終了中にハブで変えた値を、古い実行で戻さないためです
 */
export function effortToFollow(a, change) {
  if (!a || !change) return undefined;
  if (change.value === (a.effort || '')) return undefined;
  if (change.at < (a.processStartedAt ?? 0) || change.at <= (a.effortSetAt ?? 0)) return undefined;
  return change.value;
}
