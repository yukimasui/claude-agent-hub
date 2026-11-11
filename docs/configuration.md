# 設定

Agent Hub の設定は環境変数で行います。`npm start` の前に指定してください（例: `HUB_PORT=4318 npm start`）。

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `HUB_PORT` | `4317` | 待ち受けポート（127.0.0.1 のみ） |
| `HUB_TMUX_SESSION` | `agent-hub` | 使用する tmux セッション名 |
| `HUB_DEFAULT_MODEL` | `haiku` | API でモデルを指定せずにエージェントを作成したときのモデル。画面の作成フォームは選んだモデルを必ず送るため、画面から作成する場合は使われません |
| `HUB_WORKSPACES` | リポジトリ直下の `workspaces/` | 作業ディレクトリを空欄にしてエージェントを作成したときに、ディレクトリを作る場所。絶対パスで指定してください |
| `AGENT_HUB_HOME` | `~/.agent-hub` | 状態・イベント・hook 設定の保存先（[データの保存先](architecture.md#データの保存先)） |
| `HUB_CLAUDE_BIN` | `claude` | Claude Code の実行ファイル |
| `HUB_CONTEXT_WARN_TOKENS` | `150000` | コンテキスト量の目安（トークン数）。これを超えたエージェントに「切り替え推奨」の目印を出します（[コンテキスト量と引き継いでリセット](usage.md#コンテキスト量と引き継いでリセット)）。正の数として読めない値は既定値になります |

- 複数のハブを同時に動かす場合は、`HUB_PORT`・`AGENT_HUB_HOME`・`HUB_TMUX_SESSION` をすべて別の値にしてください。データ置き場や tmux セッションを共有すると、互いのエージェントの状態が混ざります。
- Agent Hub 自体の開発で使う開発用ハブの設定は、開発ガイド（[CLAUDE.md](../CLAUDE.md#開発用ハブnpm-run-dev)）を参照してください。
