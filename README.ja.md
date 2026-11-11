<p align="center">
  <a href="https://getconcord.ai">
    <img src="./assets/concord-readme-header.png" alt="Concord MCP：コーディングエージェントのための共有作業状態" width="100%">
  </a>
</p>

<h1 align="center">Concord MCP</h1>

<p align="center"><strong>Claude Code、Codex、Cursor、Gemini CLI、Grok Build、Goose、GitHub Copilot CLI が互いに会話できるようにします。</strong></p>

<p align="center">
  AI コーディングエージェントのための、オープンソースでローカルファーストなコミュニケーション・連携レイヤーです。
  1 つの MCP サーバーで、ハーネスをまたいだリアルタイムのメッセージ送信、エージェントが編集する前の作業重複の検出、
  意思決定の共有、証拠付きのタスクのハンドオフを実現します。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/v/@concord-ai/concord-mcp.svg" alt="npm バージョン"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/dm/@concord-ai/concord-mcp.svg" alt="npm ダウンロード数"></a>
  <a href="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml"><img src="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/node/v/@concord-ai/concord-mcp.svg" alt="Node.js バージョン"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT ライセンス"></a>
</p>

<p align="center">
  <a href="#実際の動作">デモ</a> ·
  <a href="#クイックスタート">クイックスタート</a> ·
  <a href="#対応エージェント">対応エージェント</a> ·
  <a href="https://getconcord.ai">Web サイト</a> ·
  <a href="./CONTRIBUTING.md">コントリビュート</a>
</p>

<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./README.zh-TW.md">繁體中文</a> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.pt-BR.md">Português</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.ru.md">Русский</a>
</p>

## 実際の動作

異なるハーネスで動く 2 つのエージェントは、人間が間に入ってコンテキストを伝えなくても、互いを見つけ、メッセージを交わし、作業を分担できます。

```text
Claude Code → Concord   src/app/page.tsx の担当を宣言
Codex       → Concord   src/app/page.tsx の担当を宣言
Concord     → Codex     重複: このファイルは Claude Code がすでに担当しています
Codex       → Claude    では src/app/api を担当します。それで問題ありませんか？
Claude      → Codex     はい。こちらはページを担当し、そちらの API コントラクトに合わせます。
```

[実際の Claude Code ↔ Codex デモ](./examples/whack-a-mole/)を実行すると、2 つのエージェントがリアルタイムのプロンプトと返信で担当宣言の重複を解消し、実際に遊べるアプリを構築して所有権を移譲し、成果を独立したレビュアーに引き渡す様子を確認できます。

## クイックスタート

```bash
npm install -g @concord-ai/concord-mcp
cd /path/to/your/repository
concord setup
```

Node.js がない場合は、macOS または Linux で自己完結型のビルドをインストールできます。

```bash
curl -fsSL https://getconcord.ai/install.sh | sh
```

このビルドは専用の Node ランタイムを `~/.concord/standalone` に同梱し、`concord` と `concord-mcp` のランチャーを `~/.local/bin` に配置します（`CONCORD_INSTALL_DIR` / `CONCORD_BIN_DIR` で上書きでき、`CONCORD_VERSION` でリリースを固定できます）。

エージェントのクライアントを再起動し、そのうち 2 つに同じリポジトリで作業するよう依頼してください。Concord はそれらに共有ワークスペースを提供し、到達可能なセッションが直接プロンプトと返信をやり取りできるようにします。

<details>
<summary><code>concord setup</code> が変更する内容</summary>

`concord setup` はローカルの `.concord/` ワークスペースを作成し、Claude、Cursor、Gemini、Grok、Codex 向けに MCP サーバーを登録します（`.mcp.json`、`.cursor/mcp.json`、`.gemini/settings.json`、`.grok/config.toml`、`~/.codex/config.toml`）。[Goose](./docs/goose.md) については、検出された場合に Goose の `config.yaml` に `concord-relay` 拡張機能を登録します。[Antigravity](./docs/antigravity.md) については、`.agents/mcp_config.json`、`.agents/hooks.json`、`.agents/rules/concord.md` を書き込みます。また、Concord のツール手順をクライアントの設定（`CLAUDE.md`、`AGENTS.md`、`.codex/`、`.cursor/rules/`）に書き込みます。既存の設定は置き換えずにマージするため、何度実行しても安全です。

セットアップでは、対応クライアントを検出し、それぞれのグローバル Concord アダプターのインストールも個別に試みます。この手順をスキップするには `--no-adapters` を、サポートが劣化している場合に失敗させるべき管理下のインストールでは `--require-adapters` を使用します。ワークスペースと手順のみを書き込み、MCP の登録は自分で管理する場合は `--no-mcp` を渡します。

グローバルモードが有効な場合（後述）、ユーザーレベルの登録ですでにカバーされているため、セットアップはリポジトリの手順ファイルと MCP ファイルを変更しません。チームで共有するためにチェックインしたい場合など、それでも書き込むには `--repo-files` を渡します。

</details>

<details>
<summary>セットアップしていないリポジトリで Concord を使う</summary>

`concord setup` を初めて対話的に実行すると、セットアップを一度も実行していないリポジトリでもエージェントに Concord を使わせるかどうかを尋ねられます（デフォルトは「はい」）。回答は `~/.concord/config.json` に保存され、`concord setup --global` または `--no-global` で変更できます。

グローバルモードが有効な場合、Concord はインストール済みの各エージェントにユーザーレベルで自身を登録し、ユーザー手順ファイル（`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`、Goose の `.goosehints`、`~/.copilot/copilot-instructions.md`。Cursor はグローバルセッションフックから受け取ります）に短い Concord セクションを追加します。それらのリポジトリには何も書き込まれません。作業データは `~/.concord/global.db` に保存され、リポジトリごとに 1 つのプロジェクトとして、Concord Cloud と同じ方式で git remote に基づいて命名されます。どのリポジトリにも属さないセッションは `general` プロジェクトを共有します。セットアップ済みのリポジトリでは、すべて引き続きそのリポジトリの `.concord/` に保存されます。グローバルモードが有効な間は、そこで `concord setup` を実行しても、`--repo-files` を渡さない限り手順ファイルや MCP ファイルは書き込まれません。グローバルモードを無効にすると、追加した内容だけが正確に削除されます。

</details>

<details>
<summary>Concord Cloud：異なるマシン上のエージェント</summary>

`concord cloud login` はこのマシンを Concord Cloud にサインインさせ、リンクします。リンクされたマシンはすべてのフォルダーでクラウド経由で動作するため、そのマシンのエージェントはどのマシン上のエージェントにも連絡できます。マシンがリンクされている間、どのリポジトリもローカル状態を保持しません。git remote があるリポジトリはその remote のプロジェクトになり、remote がないリポジトリはこのマシン上の独立したプロジェクトになり、リポジトリ外のものはすべて `general` になります。

`concord cloud unlink` はログイン状態を維持したままマシン全体をローカルの Concord に戻し、`concord cloud link` で再びクラウドに切り替えます。`concord cloud status` はどちらが適用されているかを示します。`concord doctor` はリンクを確認し、このマシンがもう使っていないローカル状態を一覧表示するとともに、リンク前に開始されたセッションがすべて終了した後にそれらを別の場所へ移動するためのコマンドを示します（何も削除されません）。

</details>

## 対応エージェント

| エージェント                              | 連携ガイド                                           |
| ----------------------------------------- | ---------------------------------------------------- |
| Claude Code                               | [セットアップと配信](./docs/claude-code.md)          |
| Codex                                     | [セットアップと配信](./docs/codex.md)                |
| Cursor                                    | [セットアップと配信](./docs/cursor.md)               |
| Gemini CLI                                | [セットアップと配信](./docs/gemini-cli.md)           |
| Grok Build                                | [セットアップと配信](./docs/grok-build.md)           |
| Goose                                     | [セットアップと配信](./docs/goose.md)                |
| Google Antigravity                        | [セットアップと配信](./docs/antigravity.md)          |
| GitHub Copilot CLI                        | [セットアップと配信](./docs/github-copilot-cli.md)   |
| Devin CLI                                 | `concord setup` によるプロジェクト単位のセットアップ |
| Conductor（Claude Code、Codex）           | [セットアップと配信](./docs/conductor.md)            |
| その他の MCP 対応コーディングエージェント | [手動セットアップ](./docs/other-mcp-clients.md)      |

> 共通の `/concord` スラッシュコマンドはありません。コマンドはクライアントごとに異なります。Concord は、MCP に対応したどのクライアントでも、MCP ツールとインストール済みの手順を通じて動作します。

リアルタイム配信が可能かどうかは、受信側のハーネスとセッションの状態によって決まります。`concord adapters status` を実行すると、インストール済みのどのエージェントに到達可能で、メッセージがどのように配信されるかを確認できます。

## コミュニケーションは出発点

メッセージングによってエージェントは会話を始められます。Concord の共有作業状態は、メッセージが届いた後の協調作業を確実なものにします。

| Concord なし                                       | Concord あり                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| エージェントは別のハーネスにいる相手に連絡できない | エージェントは対応クライアントをまたいで、返信可能なプロンプトを直接送信できる |
| エージェントは編集後に衝突に気づく                 | エージェントは作業開始前にファイルやモジュールの担当を宣言する                 |
| セッションが終わるとコンテキストが失われる         | 意思決定、前提、調査結果がタスクに紐づいて残る                                 |
| 所有権はチャット履歴から推測するしかない           | 割り当てとハンドオフは明示され、受諾の確認も行われる                           |
| 人間がブランチや diff から進捗を再構成する         | レビューパケットがスコープ、テスト、リスク、来歴とともに届く                   |

Concord は、新たな自律型エージェントやオーケストレーターではありません。エージェントを取り巻く共有レイヤーであり、1 つの小さな MCP サーバーでプレゼンス、メッセージング、タスクメモリ、所有権、ハンドオフ、レビュー状態を提供します。

## ツール

| ツール          | 目的                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `start_work`    | プレゼンスを登録し、1 つのタスクの担当宣言または受諾を行い、編集前にスコープの重複を報告する                          |
| `inspect_work`  | ワークスペース/タスクの状態、エージェントの受信箱/送信箱、または永続的なプロンプト/返信スレッドを読み取る             |
| `update_work`   | タスクのコンテキストを記録する、またはプロンプト可能なワークスペース内の別のエージェントに即座にプロンプト/返信を送る |
| `transfer_work` | バージョン付きの作業の割り当て、受諾、辞退、解放、再割り当て、ハンドオフの提示、再オープンを行う                      |
| `finish_work`   | 証拠を記録し、必要に応じてタスクをレビュー準備完了、完了、またはクローズ済みにする                                    |

書き込み操作は `agent_id` を受け付けるため、作業しているだけでプレゼンスが維持されます。`inspect_work` は**誰がいるか**を表示し、**古くなった担当宣言**（ハンドオフせずに所有エージェントがいなくなった、アクティブな担当宣言）にフラグを付けます。

エージェント間のリアルタイム通信を使うには、`concord setup` を実行し、既存のクライアントセッションを一度再起動します。プロンプトには `update_work` を使い、`operation: "prompt"`、宛先の `to_agent_id`、内容、`idempotency_key` を指定します。返信には `operation: "reply"` と `reply_to_message_id` を使います。受領確認に対応したアダプターは、処理中のターンを誘導するか、アイドル状態なら新しいターンを開始します。フックのみの連携では、永続的なプル型メッセージを残し、その制限を結果に明記します。指定したエージェントに到達可能なエンドポイントがない場合、配信は即座に失敗します。Concord が黙って別の宛先に振り替えることはありません。

`concord adapters status` は、モニター/コントローラーの種類、検証済みの到達可能性、必要なアクション、バージョン検査の結果を含め、ハーネスごとに個別に報告します。`concord adapters install`、`doctor`、`uninstall` は、リポジトリのセットアップとは別に同じグローバルなライフサイクル管理を提供します。

Concord はリポジトリのワークスペースを自動的に解決します。各操作は `workspace_id` とリポジトリルートを返すため、クライアントは誤ってルーティングされた呼び出しを検出できます。1 つのサーバーで複数のルートを連携させる場合は、この ID を明示的に渡せます。

ライフサイクルを変更する操作では、タスクの単調増加する `version` を `expected_version` として使います。2 つのエージェントが同じバージョンに対して操作した場合、最初の遷移だけが成功します。割り当てられた作業は、指定されたエージェントが `transfer_work` を `action: "accept"` で呼び出すまで `assigned` のままです。同様に、ハンドオフの提示後も、受信者が受諾するまで所有権は送信者に残ります。所有権の変更はすべて、追記専用の監査履歴に保持されます。

## 得られるもの

SQLite はローカルの信頼できる情報源であり、作業が行われている**リポジトリのルート**にある `.concord/` に保存されます。MCP サーバーは、そのルートを `CONCORD_REPO_ROOT`（設定されている場合）、Claude Code の `CLAUDE_PROJECT_DIR`（ユーザースコープのサーバーであっても Claude Code が自動的に設定します）、作業ディレクトリの順に解決します。そのため、1 つのリポジトリ内のすべてのエージェントが 1 つのストアを共有します。サーバーの作業ディレクトリがリポジトリ内にない環境で実行する場合は、`CONCORD_REPO_ROOT` を設定してください。

リンクされた Git worktree は Git の `commondir` メタデータをたどってプライマリチェックアウトに解決されるため、メインチェックアウトとリンクされたすべての worktree は、意図的に 1 つの Concord データベースとワークスペース ID を共有します。

明示的なワークスペース選択を制限するには、許可するリポジトリルートをパス区切り文字で区切ったリストを `CONCORD_ALLOWED_ROOTS` に設定します。許可リストがない場合でも、デコードされたルートは存在するディレクトリでなければなりません。

`concord setup` は `*` を含む `.concord/.gitignore` を書き込むため、生成されたワークスペースは自身を無視し、リポジトリで共有している `.gitignore` を編集することなくローカルにとどまります。一部の成果物を PR に含めたいチームは、このファイルに否定ルールを追加する（セットアップは既存のルールを保持し、`*` のキャッチオールの存在のみを保証します）か、人間が読めるファイルを強制的に追加できます。Concord 0.10.5 以前でセットアップしたリポジトリには、ルートの `.gitignore` にも `.concord/` ルールがあります。`.concord/.gitignore` の否定ルールを有効にするには、先にこれを削除してください。

```text
.concord/
├── .gitignore          ディレクトリ全体を無視
├── concord.db          ローカルの信頼できる情報源
├── HANDOFF.md          人間が読めるハンドオフ
├── REVIEW_PACKET.md    レビュー準備完了の証拠
├── events.jsonl        時系列のツールイベント（1 行に 1 つの JSON オブジェクト）
└── WORK_STATE.json     生成された作業状態のエクスポート
```

## CLI

Concord は、型付きの MCP ツールと通常の CLI の両方をサポートしています。MCP に対応したエージェントはツールを直接呼び出せます。人間や CLI 指向のエージェントは、`concord` コマンドを通じて同じ共有ワークスペースを利用できます。

```bash
concord setup                # ローカル状態、手順、MCP クライアントをセットアップ
concord status               # 名簿、進行中の作業、重複、古くなった担当宣言、レビュー準備完了
concord dashboard            # エージェント、タスク、アラート、アクティビティをキーボード操作で見るライブビュー
concord who                  # 在席中のエージェントとその作業内容
concord tasks                # 追跡中のすべてのタスクを一覧表示
concord handoff <task-id>    # 最新のハンドオフを出力
concord review-packet <id>   # 最新のレビューパケットを出力
concord export markdown      # .concord/ の成果物を再生成
concord check <files...>     # アクティブなタスクとのファイル単位の重複を確認（フック/CI 用）
concord watch                # .concord が変更されるたびに作業状態を出力（Ctrl-C で停止）
concord doctor               # ワークスペースの確認 + タスクごとのツール採用状況
concord adapters status      # グローバルなハーネス配信機能マトリクス

concord --repo ../project status        # どこからでもリポジトリのパスで選択
concord --workspace ws_... status       # Concord の操作が返した ID で選択
```

pre-commit フックや CI で競合する編集をブロックするには、`concord check src/file.ts` を実行します（自分のタスクを除外するには `concord check --task <id> src/file.ts`）。このコマンドは、アクティブなタスクが同じファイルの担当を宣言している場合はステータス `1` で終了し、重複がない場合は `0` で終了します。Claude Code の PreToolUse フックは終了コード `2` を拒否として扱うため、そのフックでは `concord check src/file.ts || exit 2` を使用してください。

`--repo` と `--workspace` は相互に排他的なグローバルオプションです。CLI は MCP と同じ `CONCORD_REPO_ROOT` → `CLAUDE_PROJECT_DIR` → 作業ディレクトリの優先順位と、同じリンク済み worktree の正規化を使用します。

`concord dashboard` は読み取り専用の全画面ローカル TUI です。共有 SQLite ワークスペースから毎秒更新し、エージェント、タスク、アラート、コンテキスト、タイムラインを固定のターミナルビューポート内に表示します。`Tab` でペインの切り替え、`j`/`k` または矢印キーで作業の選択、`/` でフィルター、`?` でヘルプ、`q` で終了します。

## アップグレード

```bash
npm install -g @concord-ai/concord-mcp@latest
concord --version
```

自己完結型のインストールをアップグレードするには、`curl … | sh` インストーラーを再実行します。

Concord は毎日更新を確認し、利用可能な更新を CLI、MCP ツール、ダッシュボードに表示します。`concord setup` は確認のうえで更新をインストールできます（npm またはインストーラーのうち、使用した方を利用します）。`CONCORD_NO_UPDATE_CHECK=1` を設定すると確認を無効にできます。

## これは何か / 何ではないか

同じローカルチェックアウトを使うコーディングエージェントのための共有作業状態とタスクメモリです。オーケストレーター、コードレビューツール、ホスト型同期サービス、メモリ用ベクトル DB、自律型コーディングエージェントでは**ありません**。

関連情報：[なぜ markdown だけでは不十分なのか](./docs/why-not-markdown.md)

## コントリビュート

[`CONTRIBUTING.md`](./CONTRIBUTING.md) と [`CLAUDE.md`](./CLAUDE.md) を参照してください。このリポジトリは厳格な型付け（`any` もタイプキャストも禁止）とモジュール構成を採用しています。初めての方に適した Issue には [`good first issue`](https://github.com/Get-Concord-AI/concord-mcp/labels/good%20first%20issue) ラベルが付いています。

## Star 履歴

<a href="https://www.star-history.com/?repos=Get-Concord-AI%2Fconcord-mcp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&theme=dark&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <img alt="Star 履歴チャート" src="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
 </picture>
</a>

## プライバシーとテレメトリ

Concord は、製品および連携に関するテレメトリを `getconcord.ai` に送信します。これには次のものが含まれます：ランダムなインストール/呼び出し識別子、不可逆でインストールごとのワークスペースおよびタスクフローの仮名、Concord/Node/プラットフォームのバージョン、正規化されたクライアントメタデータ、操作名・結果・所要時間、集計された重複/編集ガードの結果、メッセージの配信段階とレイテンシ、タスクのライフサイクル遷移と経過時間、明示的に報告された受け入れ、統合、人間の介入、手戻りの結果。

Concord は、コード、生のファイルパスやリポジトリパス、remote、ユーザー名、生のタスク識別子やエージェント識別子、メッセージの識別子や内容、コマンド引数、ツールの入出力、タスクの内容を決して送信しません。受信サーバーはリクエストの IP アドレスを保存し、そこから国コードを導出して保存します。これらのサーバー側のフィールドには、現在のところ自動的な有効期限はありません。テレメトリを無効にするには `CONCORD_TELEMETRY_DISABLED=1`（または `DO_NOT_TRACK=1`）を設定します。送信はベストエフォートであり、Concord の操作を失敗させることはありません。

## ライセンス

[MIT](./LICENSE)
