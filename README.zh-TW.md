<p align="center">
  <a href="https://getconcord.ai">
    <img src="./assets/concord-readme-header.png" alt="Concord MCP：程式開發 Agent 的共享工作狀態" width="100%">
  </a>
</p>

<h1 align="center">Concord MCP</h1>

<p align="center"><strong>讓 Claude Code、Codex、Cursor、Gemini CLI、Grok Build、Goose、GitHub Copilot CLI 和 OpenCode 彼此對話。</strong></p>

<p align="center">
  專為 AI 程式開發 Agent 打造的開源、本機優先的通訊與協調層。
  透過一個 MCP 伺服器，跨工具傳送即時訊息、在 Agent 動手修改前發現工作重疊、
  共享決策，並附帶證據地交接任務。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/v/@concord-ai/concord-mcp.svg" alt="npm 版本"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/dm/@concord-ai/concord-mcp.svg" alt="npm 下載量"></a>
  <a href="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml"><img src="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/node/v/@concord-ai/concord-mcp.svg" alt="Node.js 版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT 授權"></a>
</p>

<p align="center">
  <a href="#實際效果">示範</a> ·
  <a href="#快速開始">快速開始</a> ·
  <a href="#支援的-agent">支援的 Agent</a> ·
  <a href="https://getconcord.ai">官網</a> ·
  <a href="./CONTRIBUTING.md">參與貢獻</a>
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

## 實際效果

在不同工具中執行的兩個 Agent 可以發現彼此、互傳訊息並分工合作，不需要人類在中間轉述脈絡：

```text
Claude Code → Concord   認領 src/app/page.tsx
Codex       → Concord   認領 src/app/page.tsx
Concord     → Codex     重疊：Claude Code 已持有此檔案
Codex       → Claude    那我來做 src/app/api，可以嗎？
Claude      → Codex     可以。我繼續做頁面，並使用你的 API 約定。
```

執行[真實的 Claude Code ↔ Codex 示範](./examples/whack-a-mole/)，觀看兩個 Agent 透過即時提示與回覆解決認領重疊、建置一個可玩的應用程式、轉移所有權，並把成果交給獨立的審查者。

## 快速開始

```bash
npm install -g @concord-ai/concord-mcp
cd /path/to/your/repository
concord setup
```

沒有 Node.js？在 macOS 或 Linux 上可以改為安裝自帶執行環境的版本：

```bash
curl -fsSL https://getconcord.ai/install.sh | sh
```

它會把自帶的 Node 執行環境放在 `~/.concord/standalone` 下，並把 `concord` 和 `concord-mcp` 啟動器放到 `~/.local/bin`（可用 `CONCORD_INSTALL_DIR` / `CONCORD_BIN_DIR` 覆寫路徑，用 `CONCORD_VERSION` 指定版本）。

重新啟動你的 Agent 用戶端，然後讓其中兩個在同一個儲存庫中工作。Concord 會為它們提供共享工作區，並讓可連線的工作階段能夠直接接收提示和回覆。

<details>
<summary><code>concord setup</code> 會變更什麼</summary>

`concord setup` 會建立本機 `.concord/` 工作區，並為 Claude、Cursor、Gemini、Grok 和 Codex 註冊 MCP 伺服器（`.mcp.json`、`.cursor/mcp.json`、`.gemini/settings.json`、`.grok/config.toml` 和 `~/.codex/config.toml`）。對於 [Goose](./docs/goose.md)，偵測到後會在 Goose 的 `config.yaml` 中註冊 `concord-relay` 擴充功能。對於 [Antigravity](./docs/antigravity.md)，它會寫入 `.agents/mcp_config.json`、`.agents/hooks.json` 和 `.agents/rules/concord.md`。它也會把 Concord 的工具說明寫入你的用戶端設定（`CLAUDE.md`、`AGENTS.md`、`.codex/`、`.cursor/rules/`）。它會合併到現有設定中而不是取代，可以安全地重複執行。

setup 也會偵測受支援的用戶端，並分別嘗試安裝它們的全域 Concord 配接器。使用 `--no-adapters` 可略過這一步；在支援降級時應該失敗的受管安裝中，請使用 `--require-adapters`。傳入 `--no-mcp` 則只寫入工作區和說明，由你自行管理 MCP 註冊。

開啟全域模式（見下文）時，setup 不會變更儲存庫中的說明檔案和 MCP 檔案，因為使用者層級的註冊已經涵蓋了它們；如果仍想寫入（例如提交到儲存庫供團隊使用），請傳入 `--repo-files`。

</details>

<details>
<summary>在尚未 setup 的儲存庫中使用 Concord</summary>

第一次以互動方式執行 `concord setup` 時，它會詢問你的 Agent 是否應在從未執行過 setup 的儲存庫中使用 Concord（預設：是）。你的選擇儲存在 `~/.concord/config.json` 中；可用 `concord setup --global` 或 `--no-global` 變更。

開啟全域模式後，Concord 會為每個已安裝的 Agent 進行使用者層級註冊，並在其使用者說明檔案中加入一小段 Concord 內容（`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`、Goose 的 `.goosehints`、`~/.copilot/copilot-instructions.md`；Cursor 透過其全域工作階段 hook 取得）。這些儲存庫中不會寫入任何內容：它們的工作資料儲存在 `~/.concord/global.db` 中，每個儲存庫一個專案，並依 git remote 命名，與 Concord Cloud 的命名方式一致。不在任何儲存庫內的工作階段共用 `general` 專案。你已經 setup 過的儲存庫仍把所有內容保存在自己的 `.concord/` 中；全域模式開啟時，在其中執行 `concord setup` 不會寫入說明檔案或 MCP 檔案，除非傳入 `--repo-files`。關閉全域模式時，只會精確移除它加入過的內容。

</details>

<details>
<summary>Concord Cloud：跨機器的 Agent</summary>

`concord cloud login` 讓這台機器登入 Concord Cloud 並完成連結。已連結的機器在所有資料夾中都透過雲端工作，因此其 Agent 可以聯絡任何機器上的 Agent。機器保持連結期間，任何儲存庫都不保留本機狀態；有 git remote 的儲存庫對應該 remote 的專案，沒有 remote 的儲存庫在這台機器上自成一個專案，儲存庫之外的內容都屬於 `general`。

`concord cloud unlink` 會讓整台機器切回本機 Concord，同時保留登入狀態；`concord cloud link` 可再次切換回雲端。`concord cloud status` 顯示目前所處的模式；`concord doctor` 會檢查連結狀態，並列出這台機器不再使用的本機狀態，同時提供在連結前啟動的工作階段都結束後將其移開的指令（不會刪除任何內容）。

</details>

## 支援的 Agent

| Agent                             | 整合指南                                   |
| --------------------------------- | ------------------------------------------ |
| Claude Code                       | [設定與傳遞](./docs/claude-code.md)        |
| Codex                             | [設定與傳遞](./docs/codex.md)              |
| Cursor                            | [設定與傳遞](./docs/cursor.md)             |
| Gemini CLI                        | [設定與傳遞](./docs/gemini-cli.md)         |
| Grok Build                        | [設定與傳遞](./docs/grok-build.md)         |
| Goose                             | [設定與傳遞](./docs/goose.md)              |
| Google Antigravity                | [設定與傳遞](./docs/antigravity.md)        |
| GitHub Copilot CLI                | [設定與傳遞](./docs/github-copilot-cli.md) |
| OpenCode                          | [設定與傳遞](./docs/opencode.md)           |
| Devin CLI                         | 透過 `concord setup` 進行專案層級設定      |
| Conductor（Claude Code、Codex）   | [設定與傳遞](./docs/conductor.md)          |
| 其他任何支援 MCP 的程式開發 Agent | [手動設定](./docs/other-mcp-clients.md)    |

> 沒有通用的 `/concord` 斜線指令，指令因用戶端而異。在任何支援 MCP 的用戶端上，Concord 都透過 MCP 工具和已安裝的說明來運作。

即時傳遞取決於接收端工具和工作階段狀態。執行 `concord adapters status` 可查看哪些已安裝的 Agent 可連線，以及訊息將如何傳遞。

## 通訊只是起點

訊息讓 Agent 開始對話。Concord 的共享工作狀態則確保訊息送達之後，協作依然可靠。

| 沒有 Concord                   | 使用 Concord                                 |
| ------------------------------ | -------------------------------------------- |
| Agent 無法聯絡其他工具中的同伴 | Agent 可跨受支援的用戶端傳送可回覆的直接提示 |
| Agent 在修改之後才發現衝突     | Agent 在開工前認領檔案和模組                 |
| 工作階段結束後脈絡隨之消失     | 決策、假設和發現始終附在任務上               |
| 所有權只能從聊天記錄中推斷     | 指派和交接明確且需要確認                     |
| 人類要從分支和 diff 中拼湊進度 | 審查包附帶範圍、測試、風險和來源依據         |

Concord 不是又一個自主 Agent 或編排器。它是環繞在你的 Agent 周圍的共享層：透過一個小巧的 MCP 伺服器提供上線狀態、訊息、任務記憶、所有權、交接和審查狀態。

## 工具

| 工具            | 用途                                                             |
| --------------- | ---------------------------------------------------------------- |
| `start_work`    | 註冊上線狀態，認領或接受一個任務，並在修改前回報範圍重疊         |
| `inspect_work`  | 讀取工作區/任務狀態、Agent 的收件匣/寄件匣，或持久的提示/回覆串  |
| `update_work`   | 記錄任務脈絡，或立即向工作區中另一個可接收提示的 Agent 提示/回覆 |
| `transfer_work` | 指派、接受、拒絕、釋出、重新指派、提出交接或重新開啟帶版本的工作 |
| `finish_work`   | 記錄證據，並可選擇將任務標記為待審查、已完成或已關閉             |

寫入操作接受 `agent_id`，因此只要在工作，上線狀態就會保持活躍。`inspect_work` 會顯示**誰在這裡**，並標記**過期認領**，即所屬 Agent 未交接就已離開的活躍認領。

要使用 Agent 之間的即時通訊，請執行 `concord setup`，然後把現有用戶端工作階段重新啟動一次。提示使用 `update_work`，並帶上 `operation: "prompt"`、目標 `to_agent_id`、內容和 `idempotency_key`；回覆使用 `operation: "reply"` 和 `reply_to_message_id`。帶回條的配接器會引導忙碌中的回合，或啟動一個閒置的回合。僅支援 hook 的整合會留下一則持久的拉取訊息，並在結果中說明這項限制。當指定的 Agent 沒有可連線的端點時，傳遞會立即失敗；Concord 不會悄悄改傳給別人。

`concord adapters status` 會分別回報每個工具的情況，包括監視器/控制器類型、已驗證的連線能力、需要的操作和版本探測結果。`concord adapters install`、`doctor` 和 `uninstall` 在儲存庫 setup 之外提供同樣的全域生命週期管理。

Concord 會自動解析儲存庫工作區。各項操作都會回傳 `workspace_id` 和儲存庫根目錄，方便用戶端發現路由錯誤的呼叫；當一個伺服器協調多個根目錄時，可以明確傳入該 id。

改變生命週期的操作使用任務單調遞增的 `version` 作為 `expected_version`。如果兩個 Agent 基於同一版本操作，只有第一個狀態轉換會成功。指派後，工作會保持 `assigned` 狀態，直到被指定的 Agent 使用 `transfer_work` 並傳入 `action: "accept"`；同樣地，提出交接後，所有權仍屬於傳送方，直到接收方接受。每一次所有權變更都保留在僅附加的稽核歷史中。

## 你將獲得什麼

SQLite 是本機事實來源，儲存在正在進行工作的**儲存庫根目錄**下的 `.concord/` 中。MCP 伺服器依下列順序解析根目錄：已設定的 `CONCORD_REPO_ROOT`，接著是 Claude Code 的 `CLAUDE_PROJECT_DIR`（Claude Code 會自動設定，即使是使用者層級的伺服器也一樣），最後是其工作目錄。因此，同一儲存庫中的所有 Agent 共享同一份儲存資料。當伺服器的工作目錄不在儲存庫內時，請設定 `CONCORD_REPO_ROOT`。

連結的 Git worktree 會根據 Git 的 `commondir` 中繼資料指向主要檢出，因此主要檢出和所有連結的 worktree 會刻意共享同一個 Concord 資料庫和工作區 id。

要限制明確的工作區選擇，請將 `CONCORD_ALLOWED_ROOTS` 設定為以路徑分隔符號分隔的允許儲存庫根目錄清單。沒有允許清單時，解碼後的根路徑仍必須存在且是目錄。

`concord setup` 會寫入一個內容為 `*` 的 `.concord/.gitignore`，因此產生的工作區會忽略自身並保留在本機，不需要修改儲存庫共用的 `.gitignore`。希望在 PR 中包含部分產物的團隊，可以在該檔案中加入否定規則（setup 會保留現有規則，只確保存在 `*` 萬用規則），或強制加入這些人類可讀的檔案。由 Concord 0.10.5 或更早版本設定的儲存庫，其根目錄 `.gitignore` 中還有一條 `.concord/` 規則；需要先移除它，`.concord/.gitignore` 中的否定規則才能生效。

```text
.concord/
├── .gitignore          忽略整個目錄
├── concord.db          本機事實來源
├── HANDOFF.md          人類可讀的交接文件
├── REVIEW_PACKET.md    待審查的證據
├── events.jsonl        依時間排序的工具事件，每行一個 JSON 物件
└── WORK_STATE.json     產生的工作狀態匯出
```

## CLI

Concord 同時支援具型別的 MCP 工具和一般 CLI。支援 MCP 的 Agent 可以直接呼叫工具；人類和偏向 CLI 的 Agent 可以透過 `concord` 指令使用同一個共享工作區。

```bash
concord setup                # 設定本機狀態、說明和 MCP 用戶端
concord status               # 名單、進行中的工作、重疊、過期認領、待審查項目
concord dashboard            # 鍵盤操作的即時檢視：Agent、任務、警示和活動
concord who                  # 哪些 Agent 在線上，以及它們正在做什麼
concord tasks                # 列出所有被追蹤的任務
concord handoff <task-id>    # 列印最新的交接內容
concord review-packet <id>   # 列印最新的審查包
concord export markdown      # 重新產生 .concord/ 產物
concord check <files...>     # 檢查與活躍任務的精確檔案重疊（用於 hook/CI）
concord watch                # 在 .concord 變更時列印工作狀態（按 Ctrl-C 停止）
concord doctor               # 工作區檢查 + 各任務的工具採用情況
concord adapters status      # 全域的工具傳遞能力矩陣

concord --repo ../project status        # 從任意位置依儲存庫路徑選擇
concord --workspace ws_... status       # 選擇 Concord 操作回傳的 id
```

要在 pre-commit hook 或 CI 中阻擋衝突的修改，請執行 `concord check src/file.ts`（或用 `concord check --task <id> src/file.ts` 排除你自己的任務）。當有活躍任務認領了同一檔案時，指令以狀態碼 `1` 結束；沒有重疊時以 `0` 結束。Claude Code 的 PreToolUse hook 將結束代碼 `2` 視為拒絕，因此請在該 hook 中使用 `concord check src/file.ts || exit 2`。

`--repo` 和 `--workspace` 是互斥的全域選項。CLI 使用與 MCP 相同的 `CONCORD_REPO_ROOT` → `CLAUDE_PROJECT_DIR` → 工作目錄優先順序，以及相同的連結 worktree 標準化方式。

`concord dashboard` 是唯讀的全螢幕本機 TUI。它每秒從共享的 SQLite 工作區重新整理，並把 Agent、任務、警示、脈絡和時間軸保持在固定的終端機檢視區內。按 `Tab` 切換窗格，按 `j`/`k` 或方向鍵選擇工作，按 `/` 篩選，按 `?` 查看說明，按 `q` 結束。

## 升級

```bash
npm install -g @concord-ai/concord-mcp@latest
concord --version
```

重新執行 `curl … | sh` 安裝指令碼即可升級自帶執行環境的版本。

Concord 每天檢查一次更新，並在 CLI、MCP 工具和儀表板中提示可用更新；`concord setup` 可以在確認後安裝更新（使用 npm 或安裝指令碼，取決於你當初的安裝方式），設定 `CONCORD_NO_UPDATE_CHECK=1` 可停用檢查。

## 它是什麼 / 不是什麼

專為使用同一本機檢出的程式開發 Agent 提供的共享工作狀態和任務記憶。**不是**編排器、程式碼審查工具、託管同步服務、記憶向量資料庫或自主程式開發 Agent。

另請參閱：[為什麼不直接用 markdown？](./docs/why-not-markdown.md)

## 參與貢獻

請參閱 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 和 [`CLAUDE.md`](./CLAUDE.md)。本儲存庫採用嚴格型別（不使用 `any`，不使用型別斷言）和模組化結構。適合新手的 issue 帶有 [`good first issue`](https://github.com/Get-Concord-AI/concord-mcp/labels/good%20first%20issue) 標籤。

## Star 歷史

<a href="https://www.star-history.com/?repos=Get-Concord-AI%2Fconcord-mcp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&theme=dark&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <img alt="Star 歷史圖表" src="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
 </picture>
</a>

## 隱私與遙測

Concord 會向 `getconcord.ai` 傳送產品和協調遙測資料，其中包括：隨機的安裝/呼叫識別碼；不可逆、依安裝區分的工作區和任務流假名；Concord/Node/平台版本；標準化的用戶端中繼資料；操作名稱、結果和耗時；彙總的重疊/編輯防護結果；訊息傳遞階段和延遲；任務生命週期轉換和耗時；以及明確回報的驗收、整合、人工介入和重工結果。

Concord 絕不會傳送程式碼、原始檔案或儲存庫路徑、remote、使用者名稱、原始任務或 Agent 識別碼、訊息識別碼或內容、指令引數、工具輸入/輸出或任務內容。接收伺服器會儲存請求的 IP 位址，並由此推導和儲存國家代碼。這些伺服器端欄位目前沒有自動到期機制。設定 `CONCORD_TELEMETRY_DISABLED=1`（或 `DO_NOT_TRACK=1`）可停用遙測。傳遞採盡力而為，絕不會導致 Concord 操作失敗。

## 授權條款

[MIT](./LICENSE)
