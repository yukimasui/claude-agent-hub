# Agent Hub 開発ガイド

Agent Hub 自身を開発するときの構成・ルール・検証方法をまとめた文書です。
機能の説明・使い方・環境変数の一覧は [README.md](README.md) を参照してください（ここには書きません）。

## 構成

外部依存のない Node.js（20 以上、ES モジュール）で動きます。

| パス | 役割 |
|---|---|
| `server.js` | HTTP サーバ（API・SSE・静的ファイル配信）。エージェントの作成・再起動・削除、送信ガード、タスクキューの自動送信、対話要求への回答の書き出し、ペインの生存確認を行う |
| `lib/config.js` | 設定値の集約。**import した時点で環境変数を読む**ため、環境変数は import より前に設定する |
| `lib/store.js` | エージェント一覧と状態機械。イベント JSONL の追記分を読み（`ingest`）、`applyEvent` で状態・対話要求（`pending`）・キューの一時停止を更新する |
| `lib/interactions.js` | 対話要求の分類（`kindOf`）と、ブラウザからの回答を hook の出力 JSON に変換する処理（`buildOutput`） |
| `lib/transcript.js` | Claude Code の transcript JSONL を会話表示用の項目に整形する |
| `lib/tmux.js` | tmux 操作のラッパー（ウィンドウ作成、bracketed paste での送信、キー送信、画面取得） |
| `hooks/hub-hook.cjs` | Claude Code の hook。イベントを JSONL に追記し、対話イベントではブラウザからの回答を待つ |
| `hooks/summarize.cjs` | ツール入力の 1 行要約（hook とサーバの両方から使う） |
| `public/` | ブラウザ用の画面（ビルドなしの ES モジュール）。`md.js`（Markdown）、`triage.js`（提案の仕分け）、`cards.js`（回答待ちカード）、`queue.js`、`cats.js`、`app.js` |
| `test/` | `node:test` による単体テスト（Claude を起動しない） |
| `scripts/dev.mjs` | 開発用ハブのランチャー |
| `scripts/e2e/` | 実際の Claude Code を起動する E2E シナリオと画面確認スクリプト |

### 状態の流れ

全体の図は README の「[仕組み](README.md#仕組み)」にあります。コード上の流れは次のとおりです。

1. `server.js` が `<AGENT_HUB_HOME>/hooks.json` を生成し、`claude --settings` で渡して tmux のウィンドウで起動する。環境変数 `AGENT_HUB_AGENT`（エージェント ID）と `AGENT_HUB_HOME` を付けるので、hook はどのハブのどのエージェントかを判別できる
2. `hooks/hub-hook.cjs` がイベントごとに起動され、最小限に整形して `<AGENT_HUB_HOME>/events/<agentId>.jsonl` に追記する。hook はエージェントの邪魔をしないことを最優先にし、常に終了コード 0 で終わる
3. サーバは `fs.watch`（取りこぼし対策に 1.5 秒ごとの再読み込みも併用）で追記を検知し、`Store.ingest` → `applyEvent` で状態を更新する。**状態の正本はイベント JSONL** で、再起動時は `agents.json` と JSONL を読み直して復元する
4. 状態が変わると `Store` が `change` を発行し、SSE（`/api/stream`）でブラウザへ一覧を配信する。同じ `change` で tmux のステータス行の更新とキューの自動送信の判定も行う

### 対話要求の受け渡し

`PermissionRequest`（質問・計画承認・権限確認）と `Elicitation` は、ブラウザから回答できるようにファイルで受け渡します。

1. hook が `<AGENT_HUB_HOME>/requests/<reqId>.json` に要求の内容（自分の PID を含む）を書き、`reqId` 付きのイベントを JSONL に追記して、応答ファイルをポーリングで待つ
2. `applyEvent` が要求ファイルを読んで `pending` に加え、状態を「要対応」にする
3. ブラウザの回答は `POST /api/agents/:id/respond` → `buildOutput` で hook の出力 JSON になり、`<AGENT_HUB_HOME>/responses/<reqId>.json` に書かれる。hook はそれを標準出力に返して終了し、`InteractionDone` を追記する
4. ターミナル側で先に回答された場合は、後続のイベント（`PostToolUse` など）や新しいプロンプトから解決済みと判断し、`Store` の `cancel` を受けたサーバが応答ファイルを書いて hook を解放する。hook の PID が消えた要求は `reconcile` で取り下げる
5. ハブが止まっている（`server.json` の更新が途絶えた）場合、hook は待たずに TUI に任せる。サーバの終了時も待機中の hook をすべて解放する

## 開発時のルール

### 本番のハブに触れない

利用者の本番のハブは、ポート `4317`、データ置き場 `~/.agent-hub`、tmux セッション `agent-hub` で動いています。開発中はこれらを起動・停止・変更しないでください。

- 動作確認は、後述の開発用ハブ（`npm run dev`）で行う
- hook のスクリプトはイベントのたびにファイルから読み込まれるため、本番のハブが使っている作業ツリー（通常はリポジトリの本体）を直接編集すると、編集途中のコードが本番の監視に影響する。**作業は git worktree で行う**
- `pkill -f` のような広い範囲のプロセス停止はしない。自分で起動したハブや tmux セッションだけを止める
- 利用者の Claude Code の設定（`~/.claude/settings.json` など、テスト用の一時ディレクトリ以外にある設定）を変更しない。テストや E2E で権限を事前に許可する場合は、作業ディレクトリ内の `.claude/settings.local.json` に書くか、保存先が `session` / `localSettings` のルールだけを適用する

### git worktree での作業手順の例

```bash
# リポジトリの本体で、作業用の worktree をブランチごと作る
git fetch origin
git worktree add ../claude-agent-hub-wt/12-example -b feat/12-example origin/main
cd ../claude-agent-hub-wt/12-example

npm run dev          # 開発用ハブを起動（別の端末で）
npm test             # 単体テスト

# 作業が終わったら（PR のマージ後など）
cd -
git worktree remove ../claude-agent-hub-wt/12-example
```

worktree ごとに `hooks/` と `public/` を持つので、開発用ハブはその worktree のコードで動きます。

### 開発用ハブ（`npm run dev`）

`scripts/dev.mjs` が次の設定で `node --watch server.js` を起動します。各値は環境変数で上書きできますが、本番と同じ値を指定すると起動を拒否します。

| 環境変数 | 開発用の既定値 |
|---|---|
| `HUB_PORT` | `4400`（画面は `http://localhost:4400`） |
| `AGENT_HUB_HOME` | `~/.agent-hub-dev` |
| `HUB_TMUX_SESSION` | `agent-hub-dev` |

- `server.js` と `lib/` などの import されるファイルを変更すると自動で再起動します。`hooks/` は次のイベントから、`public/` はブラウザの再読み込みで反映されます
- 再起動のたびに、回答待ちの対話要求は TUI 側に戻されます（サーバ終了時の動作）。回答待ちの確認中はファイルを保存しないよう注意してください
- ハブが起動したエージェントの中で実行した場合、引き継がれた `AGENT_HUB_HOME`（親のハブのデータ置き場）は使わず、開発用の既定値に置き換えます
- 複数の worktree で同時に開発用ハブを動かす場合は、ポート・データ置き場・tmux セッションを別の値にしてください（例: `HUB_PORT=4401 AGENT_HUB_HOME=~/.agent-hub-dev2 HUB_TMUX_SESSION=agent-hub-dev2 npm run dev`）
- 終了は Ctrl+C です。開発用ハブが作った tmux セッションは残るので、不要になったら `tmux kill-session -t agent-hub-dev` で片付けます

### コードの書き方

- 外部依存を追加しない（Node 標準モジュールのみ）。追加が必要な場合は利用者に相談する
- コメントは日本語で、「なぜそうしているか」を書く。新しく書くコメント・文書は丁寧な口調にする
- `public/` はブラウザで直接読み込む ES モジュールなので、ビルドを前提にした書き方や Node 専用の API を使わない。テストしたい処理は DOM に触れない関数として切り出す

## 検証コマンド

変更をコミットする前に、次の 2 つがすべて通ることを確認してください。

```bash
npm test                                                        # 単体テスト（Claude を起動しない）
git ls-files -co --exclude-standard '*.js' '*.mjs' '*.cjs' | xargs -n1 node --check   # 全 JS ファイルの構文チェック
```

- `npm test` は `test/*.test.js` を `node:test` で実行します。`lib/config.js` を読み込むテストでは、一時ディレクトリを `AGENT_HUB_HOME` に設定してから動的 import してください（本番や開発用のデータ置き場に触れないため）
- 画面に関わる変更は、開発用ハブを起動してブラウザで確認してください

### E2E シナリオ（トークンを消費します）

`scripts/e2e/` のスクリプトは、実際の Claude Code（既定は haiku）を起動して確かめます。トークンを消費するため `npm test` には含めていません。hook・状態機械・対話要求・キューなどの動作を変えたときに、関係するシナリオだけを実行してください。

```bash
npm run e2e                  # シナリオの一覧と環境変数の説明
npm run e2e -- guard         # 例: 送信ガードとキュー
E2E_KEEP=1 npm run e2e -- question   # 終了後もエージェントを残す（画面確認用）
```

- 接続先は `HUB_URL`（既定は開発用ハブの `http://localhost:4400`）です。本番のハブを指定すると実行を拒否します
- 作業ディレクトリは実行ごとに一時ディレクトリを作り、終了時に削除します。新しいディレクトリでは Claude Code の信頼確認ダイアログが出るため、スクリプトが画面を見て「信頼する」を選びます（`~/.claude.json` に信頼済みディレクトリの記録が増えます。避けたい場合は `E2E_WORKDIR` に信頼済みのディレクトリを指定すると、その下に作ります）
- 作成したエージェントは終了時に削除します

### 画面確認スクリプト

```bash
npm run e2e:ui                       # モードの一覧
npm run e2e:ui -- shot [エージェントID]   # 既存のエージェントの画面を撮影（Claude は起動しない）
npm run e2e:ui -- question           # 質問カードをクリック操作で回答
npm run e2e:ui -- triage             # 提案の仕分けボードをドラッグ＆ドロップで操作
```

playwright-core はリポジトリの依存に含めていません。手元にあるものを `PLAYWRIGHT_CORE_PATH`（playwright-core のディレクトリ）で、ブラウザを `PLAYWRIGHT_CHROMIUM_EXECUTABLE` で指定できます。見つからない場合は導入方法を表示して終了します。スクリーンショットは `E2E_SHOTS_DIR`（既定は一時ディレクトリ）に保存されます。
