<p align="center">
  <a href="https://getconcord.ai">
    <img src="./assets/concord-readme-header.png" alt="Concord MCP：编程 Agent 的共享工作状态" width="100%">
  </a>
</p>

<h1 align="center">Concord MCP</h1>

<p align="center"><strong>让 Claude Code、Codex、Cursor、Gemini CLI、Grok Build、Goose、GitHub Copilot CLI 和 OpenCode 彼此对话。</strong></p>

<p align="center">
  面向 AI 编程 Agent 的开源、本地优先的通信与协调层。
  通过一个 MCP 服务器，跨工具发送实时消息、在 Agent 动手修改前发现工作重叠、
  共享决策，并附带证据地交接任务。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/v/@concord-ai/concord-mcp.svg" alt="npm 版本"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/dm/@concord-ai/concord-mcp.svg" alt="npm 下载量"></a>
  <a href="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml"><img src="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/node/v/@concord-ai/concord-mcp.svg" alt="Node.js 版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT 许可证"></a>
</p>

<p align="center">
  <a href="#实际效果">演示</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#支持的-agent">支持的 Agent</a> ·
  <a href="https://getconcord.ai">官网</a> ·
  <a href="./CONTRIBUTING.md">参与贡献</a>
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

## 实际效果

运行在不同工具中的两个 Agent 可以发现彼此、互发消息并分工协作，无需人类在中间转述上下文：

```text
Claude Code → Concord   认领 src/app/page.tsx
Codex       → Concord   认领 src/app/page.tsx
Concord     → Codex     重叠：Claude Code 已持有此文件
Codex       → Claude    那我来做 src/app/api，可以吗？
Claude      → Codex     可以。我继续做页面，并使用你的 API 约定。
```

运行[真实的 Claude Code ↔ Codex 演示](./examples/whack-a-mole/)，观看两个 Agent 通过实时提示与回复解决认领重叠、构建一个可玩的应用、转移所有权，并把成果交给独立的审查者。

## 快速开始

```bash
npm install -g @concord-ai/concord-mcp
cd /path/to/your/repository
concord setup
```

没有 Node.js？在 macOS 或 Linux 上可以改为安装自包含版本：

```bash
curl -fsSL https://getconcord.ai/install.sh | sh
```

它会把自带的 Node 运行时放在 `~/.concord/standalone` 下，并把 `concord` 和 `concord-mcp` 启动器放到 `~/.local/bin`（可用 `CONCORD_INSTALL_DIR` / `CONCORD_BIN_DIR` 覆盖路径，用 `CONCORD_VERSION` 固定版本）。

重启你的 Agent 客户端，然后让其中两个在同一个仓库中工作。Concord 会为它们提供共享工作区，并让可达的会话能够直接接收提示和回复。

<details>
<summary><code>concord setup</code> 会改动什么</summary>

`concord setup` 会创建本地 `.concord/` 工作区，并为 Claude、Cursor、Gemini、Grok 和 Codex 注册 MCP 服务器（`.mcp.json`、`.cursor/mcp.json`、`.gemini/settings.json`、`.grok/config.toml` 和 `~/.codex/config.toml`）。对于 [Goose](./docs/goose.md)，检测到后会在 Goose 的 `config.yaml` 中注册 `concord-relay` 扩展。对于 [Antigravity](./docs/antigravity.md)，它会写入 `.agents/mcp_config.json`、`.agents/hooks.json` 和 `.agents/rules/concord.md`。它还会把 Concord 的工具说明写入你的客户端配置（`CLAUDE.md`、`AGENTS.md`、`.codex/`、`.cursor/rules/`）。它会合并到现有配置中而不是替换，可以安全地重复运行。

setup 还会检测受支持的客户端，并分别尝试安装它们的全局 Concord 适配器。使用 `--no-adapters` 可跳过这一步；在支持降级时应当失败的托管安装中，请使用 `--require-adapters`。传入 `--no-mcp` 则只写入工作区和说明，由你自己管理 MCP 注册。

开启全局模式（见下文）时，setup 不会改动仓库中的说明文件和 MCP 文件，因为用户级注册已经覆盖了它们；如果仍想写入（例如提交到仓库供团队使用），请传入 `--repo-files`。

</details>

<details>
<summary>在尚未 setup 的仓库中使用 Concord</summary>

首次以交互方式运行 `concord setup` 时，它会询问你的 Agent 是否应在从未运行过 setup 的仓库中使用 Concord（默认：是）。你的选择保存在 `~/.concord/config.json` 中；可用 `concord setup --global` 或 `--no-global` 更改。

开启全局模式后，Concord 会为每个已安装的 Agent 进行用户级注册，并在其用户说明文件中添加一小段 Concord 内容（`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`、Goose 的 `.goosehints`、`~/.copilot/copilot-instructions.md`；Cursor 通过其全局会话 hook 获取）。这些仓库中不会写入任何内容：它们的工作数据保存在 `~/.concord/global.db` 中，每个仓库一个项目，并按 git remote 命名，与 Concord Cloud 的命名方式一致。不在任何仓库内的会话共用 `general` 项目。你已经 setup 过的仓库仍把所有内容保存在自己的 `.concord/` 中；全局模式开启时，在其中运行 `concord setup` 不会写入说明文件或 MCP 文件，除非传入 `--repo-files`。关闭全局模式时，只会精确移除它添加过的内容。

</details>

<details>
<summary>Concord Cloud：跨机器的 Agent</summary>

`concord cloud login` 让这台机器登录 Concord Cloud 并完成关联。已关联的机器在所有文件夹中都通过云端工作，因此其 Agent 可以联系任何机器上的 Agent。机器保持关联期间，任何仓库都不保留本地状态；有 git remote 的仓库对应该 remote 的项目，没有 remote 的仓库在这台机器上自成一个项目，仓库之外的内容都属于 `general`。

`concord cloud unlink` 会让整台机器切回本地 Concord，同时保留登录状态；`concord cloud link` 可再次切换回云端。`concord cloud status` 显示当前所处的模式；`concord doctor` 会检查关联状态，并列出这台机器不再使用的本地状态，同时给出在关联前启动的会话都结束后将其移开的命令（不会删除任何内容）。

</details>

## 支持的 Agent

| Agent                           | 集成指南                                   |
| ------------------------------- | ------------------------------------------ |
| Claude Code                     | [设置与投递](./docs/claude-code.md)        |
| Codex                           | [设置与投递](./docs/codex.md)              |
| Cursor                          | [设置与投递](./docs/cursor.md)             |
| Gemini CLI                      | [设置与投递](./docs/gemini-cli.md)         |
| Grok Build                      | [设置与投递](./docs/grok-build.md)         |
| Goose                           | [设置与投递](./docs/goose.md)              |
| Google Antigravity              | [设置与投递](./docs/antigravity.md)        |
| GitHub Copilot CLI              | [设置与投递](./docs/github-copilot-cli.md) |
| OpenCode                        | [设置与投递](./docs/opencode.md)           |
| Devin CLI                       | 通过 `concord setup` 进行项目级设置        |
| Conductor（Claude Code、Codex） | [设置与投递](./docs/conductor.md)          |
| 其他任何支持 MCP 的编程 Agent   | [手动设置](./docs/other-mcp-clients.md)    |

> 没有通用的 `/concord` 斜杠命令，命令因客户端而异。在任何支持 MCP 的客户端上，Concord 都通过 MCP 工具和已安装的说明来工作。

实时投递取决于接收端工具和会话状态。运行 `concord adapters status` 可查看哪些已安装的 Agent 可达，以及消息将如何投递。

## 通信只是起点

消息让 Agent 开始对话。Concord 的共享工作状态则确保消息送达之后，协作依然可靠。

| 没有 Concord                   | 使用 Concord                                 |
| ------------------------------ | -------------------------------------------- |
| Agent 无法联系其他工具中的同伴 | Agent 可跨受支持的客户端发送可回复的直接提示 |
| Agent 在修改之后才发现冲突     | Agent 在开工前认领文件和模块                 |
| 会话结束后上下文随之消失       | 决策、假设和发现始终附在任务上               |
| 所有权只能从聊天记录中推断     | 分配和交接明确且需要确认                     |
| 人类要从分支和 diff 中拼凑进度 | 审查包附带范围、测试、风险和来源依据         |

Concord 不是又一个自主 Agent 或编排器。它是环绕在你的 Agent 周围的共享层：通过一个小巧的 MCP 服务器提供在线状态、消息、任务记忆、所有权、交接和审查状态。

## 工具

| 工具            | 用途                                                               |
| --------------- | ------------------------------------------------------------------ |
| `start_work`    | 注册在线状态，认领或接受一个任务，并在修改前报告范围重叠           |
| `inspect_work`  | 读取工作区/任务状态、Agent 的收件箱/发件箱，或持久的提示/回复会话  |
| `update_work`   | 记录任务上下文，或立即向工作区中另一个可接收提示的 Agent 提示/回复 |
| `transfer_work` | 分配、接受、拒绝、释放、重新分配、发起交接或重新打开带版本的工作   |
| `finish_work`   | 记录证据，并可选择将任务标记为待审查、已完成或已关闭               |

写操作接受 `agent_id`，因此只要在工作，在线状态就会保持活跃。`inspect_work` 会显示**谁在这里**，并标记**过期认领**，即所属 Agent 未交接就已离开的活跃认领。

要使用 Agent 之间的实时通信，请运行 `concord setup`，然后把现有客户端会话重启一次。提示使用 `update_work`，并带上 `operation: "prompt"`、目标 `to_agent_id`、内容和 `idempotency_key`；回复使用 `operation: "reply"` 和 `reply_to_message_id`。带回执的适配器会引导忙碌中的回合，或启动一个空闲的回合。仅支持 hook 的集成会留下一条持久的拉取消息，并在结果中说明这一限制。当指定的 Agent 没有可达端点时，投递会立即失败；Concord 不会悄悄改投给别人。

`concord adapters status` 会分别报告每个工具的情况，包括监视器/控制器类型、已验证的可达性、需要的操作和版本探测结果。`concord adapters install`、`doctor` 和 `uninstall` 在仓库 setup 之外提供同样的全局生命周期管理。

Concord 会自动解析仓库工作区。各项操作都会返回 `workspace_id` 和仓库根目录，便于客户端发现路由错误的调用；当一个服务器协调多个根目录时，可以显式传入该 id。

改变生命周期的操作使用任务单调递增的 `version` 作为 `expected_version`。如果两个 Agent 基于同一版本操作，只有第一个状态转换会成功。分配后，工作会保持 `assigned` 状态，直到被指定的 Agent 使用 `transfer_work` 并传入 `action: "accept"`；同样，发起交接后，所有权仍归发送方，直到接收方接受。每一次所有权变更都保留在只追加的审计历史中。

## 你将获得什么

SQLite 是本地事实来源，保存在正在进行工作的**仓库根目录**下的 `.concord/` 中。MCP 服务器按以下顺序解析根目录：已设置的 `CONCORD_REPO_ROOT`，然后是 Claude Code 的 `CLAUDE_PROJECT_DIR`（Claude Code 会自动设置，即使是用户级服务器也一样），最后是其工作目录。因此，同一仓库中的所有 Agent 共享同一份存储。当服务器的工作目录不在仓库内时，请设置 `CONCORD_REPO_ROOT`。

关联的 Git worktree 会根据 Git 的 `commondir` 元数据指向主检出，因此主检出和所有关联的 worktree 会有意共享同一个 Concord 数据库和工作区 id。

要限制显式的工作区选择，请将 `CONCORD_ALLOWED_ROOTS` 设置为按路径分隔符分隔的允许仓库根目录列表。没有允许列表时，解码后的根路径仍必须存在且是目录。

`concord setup` 会写入一个内容为 `*` 的 `.concord/.gitignore`，因此生成的工作区会忽略自身并保留在本地，无需修改仓库共享的 `.gitignore`。希望在 PR 中包含部分产物的团队，可以在该文件中添加否定规则（setup 会保留现有规则，只确保存在 `*` 通配规则），或强制添加这些人类可读的文件。由 Concord 0.10.5 或更早版本设置的仓库，其根目录 `.gitignore` 中还有一条 `.concord/` 规则；需要先移除它，`.concord/.gitignore` 中的否定规则才能生效。

```text
.concord/
├── .gitignore          忽略整个目录
├── concord.db          本地事实来源
├── HANDOFF.md          人类可读的交接文档
├── REVIEW_PACKET.md    待审查的证据
├── events.jsonl        按时间排序的工具事件，每行一个 JSON 对象
└── WORK_STATE.json     生成的工作状态导出
```

## CLI

Concord 同时支持带类型的 MCP 工具和常规 CLI。支持 MCP 的 Agent 可以直接调用工具；人类和偏向 CLI 的 Agent 可以通过 `concord` 命令使用同一个共享工作区。

```bash
concord setup                # 设置本地状态、说明和 MCP 客户端
concord status               # 名单、进行中的工作、重叠、过期认领、待审查项
concord dashboard            # 键盘驱动的实时视图：Agent、任务、提醒和活动
concord who                  # 哪些 Agent 在线，以及它们在做什么
concord tasks                # 列出所有被跟踪的任务
concord handoff <task-id>    # 打印最新的交接内容
concord review-packet <id>   # 打印最新的审查包
concord export markdown      # 重新生成 .concord/ 产物
concord check <files...>     # 检查与活跃任务的精确文件重叠（用于 hook/CI）
concord watch                # 在 .concord 变化时打印工作状态（按 Ctrl-C 停止）
concord doctor               # 工作区检查 + 各任务的工具采用情况
concord adapters status      # 全局的工具投递能力矩阵

concord --repo ../project status        # 从任意位置按仓库路径选择
concord --workspace ws_... status       # 选择 Concord 操作返回的 id
```

要在 pre-commit hook 或 CI 中阻止冲突的修改，请运行 `concord check src/file.ts`（或用 `concord check --task <id> src/file.ts` 排除你自己的任务）。当有活跃任务认领了同一文件时，命令以状态码 `1` 退出；没有重叠时以 `0` 退出。Claude Code 的 PreToolUse hook 将退出码 `2` 视为拒绝，因此请在该 hook 中使用 `concord check src/file.ts || exit 2`。

`--repo` 和 `--workspace` 是互斥的全局选项。CLI 使用与 MCP 相同的 `CONCORD_REPO_ROOT` → `CLAUDE_PROJECT_DIR` → 工作目录优先级，以及相同的关联 worktree 规范化方式。

`concord dashboard` 是只读的全屏本地 TUI。它每秒从共享的 SQLite 工作区刷新，并把 Agent、任务、提醒、上下文和时间线保持在固定的终端视口内。按 `Tab` 切换窗格，按 `j`/`k` 或方向键选择工作，按 `/` 筛选，按 `?` 查看帮助，按 `q` 退出。

## 升级

```bash
npm install -g @concord-ai/concord-mcp@latest
concord --version
```

重新运行 `curl … | sh` 安装脚本即可升级自包含版本。

Concord 每天检查一次更新，并在 CLI、MCP 工具和仪表盘中提示可用更新；`concord setup` 可以在确认后安装更新（使用 npm 或安装脚本，取决于你当初的安装方式），设置 `CONCORD_NO_UPDATE_CHECK=1` 可禁用检查。

## 它是什么 / 不是什么

面向使用同一本地检出的编程 Agent 的共享工作状态和任务记忆。**不是**编排器、代码审查工具、托管同步服务、记忆向量数据库或自主编程 Agent。

另请参阅：[为什么不直接用 markdown？](./docs/why-not-markdown.md)

## 参与贡献

请参阅 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 和 [`CLAUDE.md`](./CLAUDE.md)。本仓库采用严格类型（不使用 `any`，不使用类型断言）和模块化结构。适合新手的 issue 带有 [`good first issue`](https://github.com/Get-Concord-AI/concord-mcp/labels/good%20first%20issue) 标签。

## Star 历史

<a href="https://www.star-history.com/?repos=Get-Concord-AI%2Fconcord-mcp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&theme=dark&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <img alt="Star 历史图表" src="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
 </picture>
</a>

## 隐私与遥测

Concord 会向 `getconcord.ai` 发送产品和协调遥测数据，其中包括：随机的安装/调用标识符；不可逆的、按安装区分的工作区和任务流假名；Concord/Node/平台版本；规范化的客户端元数据；操作名称、结果和耗时；汇总的重叠/编辑防护结果；消息投递阶段和延迟；任务生命周期转换和耗时；以及明确上报的验收、集成、人工干预和返工结果。

Concord 绝不会发送代码、原始文件或仓库路径、remote、用户名、原始任务或 Agent 标识符、消息标识符或内容、命令参数、工具输入/输出或任务内容。接收服务器会存储请求的 IP 地址，并由此得出和存储国家代码。这些服务器端字段目前没有自动过期机制。设置 `CONCORD_TELEMETRY_DISABLED=1`（或 `DO_NOT_TRACK=1`）可禁用遥测。投递为尽力而为，绝不会导致 Concord 操作失败。

## 许可证

[MIT](./LICENSE)
