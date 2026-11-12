// エージェントの起動に関わる値の検証と、起動コマンドの組み立てです。
// tmux やファイルに触れずに単体テストできるよう、server.js から切り離しています。
// 設定値（claude の実行ファイル・hook 設定のファイルなど）は lib/config.js を読み込まずに引数で受け取ります。
// lib/config.js は import した時点で環境変数を読むため、テストでデータ置き場を用意しなくても使えるようにするためです。
import { isEffortValue } from '../public/effort.js';
import { httpError } from './http.js';

/** シェルの単一引用符で囲みます。tmux はコマンドをシェルに渡して実行するため、引数に空白や引用符があっても 1 つの引数として渡るようにします */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * 作成フォームのエフォートを、保存する値にします。許可リスト（public/effort.js の EFFORT_LEVELS）にない値は空文字にします。
 * 空文字は「ユーザー設定に従う」で、起動コマンドに --effort を付けません。
 * 不正な値で作成を拒否しないのは、作成時の権限モードなどと同じく、選ばなかったものとして扱えば足りるためです。
 */
export function effortOption(v) {
  return isEffortValue(v) ? v : '';
}

/**
 * エフォートの変更の要求（POST /api/agents/:id/effort の body）から、変更後の値を取り出します。
 * effort のキーがない場合と、値が許可リストにない場合は 400 のエラーを投げます。作成時と違って黙って空文字にしないのは、
 * 変更では動いているエージェントを起動し直すため、誤った要求で意図せず起動し直さないようにするためです
 * （キーがない要求を「ユーザー設定に従う」への変更として扱うと、エフォートが消えたうえで起動し直してしまいます）。
 * 「ユーザー設定に従う」には空文字を指定します。null も空文字として扱います。
 */
export function requestedEffort(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'effort')) throw httpError(400, 'エフォートを指定してください');
  const effort = body.effort ?? '';
  if (!isEffortValue(effort)) throw httpError(400, `エフォートの値が不正です: ${effort}`);
  return effort;
}

/**
 * claude を起動するコマンド（シェルに渡す 1 行）を組み立てます。
 * a はエージェント（model・permissionMode・effort・sessionId を使います）、bin・settingsFile・systemPrompt は設定値です。
 * resume が真なら --resume で会話を引き継ぎ、偽なら --session-id で新しいセッションを始めます。prompt があれば最初の指示として渡します。
 * エフォートが空文字（ユーザー設定に従う）のときは --effort を付けません。
 */
export function buildCommand(a, { bin, settingsFile, systemPrompt, resume = false, prompt } = {}) {
  const args = [bin, '--model', a.model, '--settings', settingsFile];
  if (a.permissionMode) args.push('--permission-mode', a.permissionMode);
  if (a.effort) args.push('--effort', a.effort);
  args.push('--append-system-prompt', systemPrompt);
  args.push(resume ? '--resume' : '--session-id', a.sessionId);
  // プロンプトが - で始まっても claude のオプションと解釈されないよう、-- の後に置きます
  if (prompt) args.push('--', prompt);
  return args.map(shq).join(' ');
}
