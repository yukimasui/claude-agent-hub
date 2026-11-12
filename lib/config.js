// 設定値の集約です。環境変数で上書きできます
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HUB_HOME = process.env.AGENT_HUB_HOME || path.join(os.homedir(), '.agent-hub');
export const EVENTS_DIR = path.join(HUB_HOME, 'events');
export const REQUESTS_DIR = path.join(HUB_HOME, 'requests');
export const RESPONSES_DIR = path.join(HUB_HOME, 'responses');
// 「引き継いでリセット」で取り出した引き継ぎメモの保存先です。作業ディレクトリには書かず、ハブのデータ置き場に残します
export const HANDOFFS_DIR = path.join(HUB_HOME, 'handoffs');
export const AGENTS_FILE = path.join(HUB_HOME, 'agents.json');
export const HOOKS_FILE = path.join(HUB_HOME, 'hooks.json');
export const HEARTBEAT_FILE = path.join(HUB_HOME, 'server.json');
// 利用上限の使用率の記録です。利用上限はアカウント単位なので、エージェントごとではなく 1 つのファイルにします
export const USAGE_FILE = path.join(HUB_HOME, 'usage.json');
export const HOOK_SCRIPT = path.join(ROOT, 'hooks', 'hub-hook.cjs');
// ステータスラインのコマンドとして動かし、利用上限の使用率を記録するスクリプトです
export const STATUSLINE_SCRIPT = path.join(ROOT, 'hooks', 'statusline.cjs');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const WORKSPACES_DIR = process.env.HUB_WORKSPACES || path.join(ROOT, 'workspaces');

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.HUB_PORT || 4317);
export const TMUX_SESSION = process.env.HUB_TMUX_SESSION || 'agent-hub';
export const CLAUDE_BIN = process.env.HUB_CLAUDE_BIN || 'claude';
export const DEFAULT_MODEL = process.env.HUB_DEFAULT_MODEL || 'haiku';

/**
 * コンテキスト量の目安（トークン数）を環境変数の値から求めます。
 * 正の数として読めない値（空・0・数字以外）は既定値にします。誤った値で目印が常に出たり出なくなったりしないようにするためです
 */
export function contextWarnTokens(value, fallback = 150000) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
// この量を超えたら、画面に「切り替え推奨」の目印を出します
export const CONTEXT_WARN_TOKENS = contextWarnTokens(process.env.HUB_CONTEXT_WARN_TOKENS);

// hook を登録するイベントの一覧です
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Elicitation',
  'ElicitationResult',
  'SessionEnd',
];
export const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
// ブラウザからの回答を待つイベントは長めのタイムアウトにします（秒）
export const INTERACTIVE_EVENTS = new Set(['PermissionRequest', 'Elicitation']);
export const INTERACTIVE_TIMEOUT_SEC = 3600;

// ハブから起動するエージェントに追加するシステムプロンプトです（提案の仕分けボード用）
export const HUB_SYSTEM_PROMPT = `このセッションは Agent Hub（ブラウザの管理画面）から操作されています。
ユーザーに複数の提案・改善案・変更候補などを示し、それぞれについて個別に判断（採用 / 不採用 / 修正して実施）してほしい場合は、応答の最後に次の形式のコードブロックを含めてください。ユーザーは画面上のカードで各項目を仕分けて回答します。

\`\`\`proposals
{"title": "提案の見出し", "items": [{"id": "1", "title": "提案の要約（1行）", "detail": "補足説明（任意）"}]}
\`\`\`

- 各項目は独立して判断できる単位にしてください。
- detail には、何をするのか・なぜか・影響や注意点など、判断に必要なことを書いてください。Markdown（箇条書き・強調・インラインコード）を使えます。改行は JSON の文字列内で \\n と書いてください。画面では各項目をカードとして表示し、クリックすると detail を Markdown として大きく表示します。
- ブロックの JSON は有効な形式にしてください。ブロックの前には通常どおり説明を書いて構いません。
- 1 つの選択肢を選ぶだけの質問には、このブロックではなく AskUserQuestion ツールを使ってください。`;
