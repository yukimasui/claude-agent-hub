# 仕組み

Agent Hub が Claude Code の状態をどう受け取り、画面に反映しているかをまとめた文書です。
コード上の処理の流れ（どのモジュールが何をするか）は、開発ガイド（[CLAUDE.md](../CLAUDE.md#状態の流れ)）を参照してください。

## 全体の構成

```
claude (tmux pane) ──hook──▶ hooks/hub-hook.cjs ──append──▶ ~/.agent-hub/events/<agentId>.jsonl
                                                                   │ fs.watch
                                                                   ▼
                     ブラウザ ◀──SSE── server.js（状態機械） ──▶ tmux @hub_state（ステータス行の色分け）
                        │                    │
                        └─send/keys─▶ tmux paste-buffer / send-keys
                                             └─▶ transcript JSONL を読み取って会話表示
```

- 各エージェントは、tmux セッション（既定は `agent-hub`）の 1 ウィンドウで動く通常の Claude Code です。ハブのサーバを停止しても、エージェントは tmux 上で動き続けます。
- hook 設定は `~/.agent-hub/hooks.json` に生成し、`claude --settings` で渡します。hook を登録するためにグローバル設定（`~/.claude/settings.json`）を変更することはありません（ただし、ブラウザの「許可して記憶」で保存先が「このセッション」以外のルールを選んだ場合は、Claude Code が作業ディレクトリの `.claude/settings.local.json`・`.claude/settings.json` や `~/.claude/settings.json` に書き込みます。[使い方](usage.md#ブラウザからの回答)を参照）。
- hook は、ハブが付けた環境変数 `AGENT_HUB_AGENT` と `AGENT_HUB_HOME` があるセッションでのみ動作し、常に終了コード 0 で終了します。ハブの外で起動した Claude Code には影響しません。
- 入力欄からの送信は tmux の bracketed paste で、キー送信ボタンは `send-keys` で行います。会話の表示は Claude Code の transcript JSONL を読み取って整形します。
- ブラウザの画面と API は、サーバが `127.0.0.1` で待ち受けて提供します。ほかのサイトからの操作（DNS rebinding や CSRF）を防ぐため、`Host` が `localhost` / `127.0.0.1` 以外の要求、別の `Origin` からの要求、JSON 以外の更新要求は拒否します。認証はありません（[重要な注意](../README.md#重要な注意)）。

## 状態の判定

状態の解釈はサーバ側（`lib/store.js` の `applyEvent`）で行います。hook イベントと状態の対応は次のとおりです。

| hook イベント | 状態 |
|---|---|
| SessionStart | 待機中 |
| UserPromptSubmit / PreToolUse / PostToolUse | 実行中 |
| PermissionRequest / Elicitation / Notification(permission_prompt) | 要対応 |
| Stop / StopFailure / Notification(idle_prompt) | 応答完了 |
| PreCompact | 圧縮中 |
| SessionEnd / ペインのプロセス終了 | 終了 |

- 作成直後と再起動直後は、最初のイベントが届くまで「起動中」です。
- 中断（Esc / Ctrl+C）では Stop hook が届かないため、ハブのキー送信ボタンから送った場合だけ「待機中」に戻します（[既知の制約](usage.md#既知の制約)）。
- hook では拾えないクラッシュに備えて、サーバは 2 秒ごとに tmux のペインを確認し、プロセスが終了していれば「終了」にします。

## ブラウザからの回答の受け渡し

質問・計画の承認・権限の確認（`PermissionRequest`）と MCP の入力要求（`Elicitation`）では、hook が要求の内容をファイルに書き出し、ブラウザからの回答を待ちます。

- サーバは 5 秒ごとに `~/.agent-hub/server.json` を更新して、稼働中であることを知らせます。更新が 20 秒以上途絶えている場合、hook は待機せずにすぐ TUI に処理を任せます。
- 回答の受け渡しの手順は、開発ガイド（[CLAUDE.md](../CLAUDE.md#対話要求の受け渡し)）にまとめています。利用者から見た動作は[使い方](usage.md#ターミナルとの関係)を参照してください。

## mermaid の同梱

会話や計画の mermaid 図は、リポジトリに同梱した mermaid（`public/vendor/mermaid/`）をハブのサーバから配信して描画します。画面は、mermaid のブロックを表示するときにだけこのファイルを読み込みます。

- **同梱している理由**: 読み込んだスクリプトはハブの画面と同じオリジンで動くため、CDN の配信内容が差し替えられると、エージェントへの送信や権限確認への回答などハブの API を操作できてしまいます。ハブには認証がないので影響が大きく、外部から読み込まない方法を選んでいます。
- **ファイルの確かめ方**: npm レジストリが公開している tarball の integrity（`dist.integrity` / `dist.shasum`）と一致することを確かめてから配布ファイルを取り出し、変更せずに置いています。同梱したファイルの SHA-256 は `SHA256SUMS` に記録し、`npm test` で一致を確かめます。取得元・バージョン・更新手順は [public/vendor/mermaid/README.md](../public/vendor/mermaid/README.md) にあります。
- **限界**: 防げるのは、配信経路（CDN）での差し替えだけです。npm に公開された時点の mermaid 自体に問題があれば、そのまま取り込みます。また、更新は手作業で、mermaid の不具合や脆弱性の修正は自動では反映されません。必要に応じて更新手順に沿って入れ替えてください。リポジトリの容量は配布ファイルの分（約 3.3 MB）増えます。

## データの保存先

ハブのデータは `AGENT_HUB_HOME`（既定は `~/.agent-hub`）に保存します。

| パス | 内容 |
|---|---|
| `agents.json` | エージェントの一覧（名前・モデル・作業ディレクトリ・tmux のウィンドウ・セッション ID・キューなど） |
| `events/<agentId>.jsonl` | hook が追記するイベント。状態の正本で、ハブの再起動時はこれを読み直して状態を復元します。エージェントを削除すると消えます |
| `requests/` / `responses/` | 回答待ちの対話要求と、ブラウザからの回答。ツールの入力（コマンドや書き込む内容）を含み、回答が済むと消えます |
| `hooks.json` | `claude --settings` で渡す hook 設定。サーバの起動時に生成します |
| `server.json` | サーバの稼働確認用のファイル（PID・ポート・更新時刻） |

- イベントには、プロンプトやメッセージの先頭部分（最大 500 文字）とツール入力の 1 行要約が含まれます。
- 会話の記録（transcript）は Claude Code 自身が保存するもので、ハブは読み取るだけです。
- 提案の仕分けの途中経過と、選択中のエージェント・タブは、ブラウザの localStorage に保存します。
