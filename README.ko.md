<p align="center">
  <a href="https://getconcord.ai">
    <img src="./assets/concord-readme-header.png" alt="Concord MCP — 코딩 에이전트를 위한 공유 작업 상태" width="100%">
  </a>
</p>

<h1 align="center">Concord MCP</h1>

<p align="center"><strong>Claude Code, Codex, Cursor, Gemini CLI, Grok Build, Goose, GitHub Copilot CLI가 서로 대화하게 하세요.</strong></p>

<p align="center">
  AI 코딩 에이전트를 위한 오픈소스, 로컬 우선 커뮤니케이션 및 협업 조율 계층입니다.
  하나의 MCP 서버로 하니스 간에 실시간 메시지를 보내고, 에이전트가 편집하기 전에 작업 겹침을 감지하고,
  결정 사항을 공유하고, 증거와 함께 작업을 핸드오프할 수 있습니다.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/v/@concord-ai/concord-mcp.svg" alt="npm 버전"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/dm/@concord-ai/concord-mcp.svg" alt="npm 다운로드 수"></a>
  <a href="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml"><img src="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/node/v/@concord-ai/concord-mcp.svg" alt="Node.js 버전"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT 라이선스"></a>
</p>

<p align="center">
  <a href="#동작-살펴보기">데모</a> ·
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="#지원-에이전트">지원 에이전트</a> ·
  <a href="https://getconcord.ai">웹사이트</a> ·
  <a href="./CONTRIBUTING.md">기여하기</a>
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

## 동작 살펴보기

서로 다른 하니스에서 실행되는 두 에이전트가 사람이 컨텍스트를 전달해 주지 않아도 서로를 발견하고, 메시지를 주고받고, 작업을 나눌 수 있습니다:

```text
Claude Code → Concord   src/app/page.tsx 선점
Codex       → Concord   src/app/page.tsx 선점
Concord     → Codex     겹침: Claude Code가 이미 이 파일을 소유하고 있습니다
Codex       → Claude    그럼 제가 src/app/api를 맡을게요. 괜찮을까요?
Claude      → Codex     네. 저는 페이지를 맡고 그쪽 API 계약을 따를게요.
```

[실제 Claude Code ↔ Codex 데모](./examples/whack-a-mole/)를 실행하면 두 에이전트가 실시간 프롬프트와 응답으로 선점 겹침을 해결하고, 플레이 가능한 앱을 만들고, 소유권을 이전하고, 결과물을 독립적인 리뷰어에게 넘기는 과정을 볼 수 있습니다.

## 빠른 시작

```bash
npm install -g @concord-ai/concord-mcp
cd /path/to/your/repository
concord setup
```

Node.js가 없나요? macOS나 Linux에서는 대신 독립 실행형 빌드를 설치할 수 있습니다:

```bash
curl -fsSL https://getconcord.ai/install.sh | sh
```

자체 Node 런타임을 `~/.concord/standalone` 아래에 번들로 포함하고 `concord` 및 `concord-mcp` 실행 파일을 `~/.local/bin`에 넣습니다 (`CONCORD_INSTALL_DIR` / `CONCORD_BIN_DIR`로 경로를 변경하고, `CONCORD_VERSION`으로 릴리스를 고정할 수 있습니다).

에이전트 클라이언트를 재시작한 다음, 그중 두 개에게 같은 저장소에서 작업하도록 요청하세요. Concord는 이들에게 공유 워크스페이스를 제공하고, 도달 가능한 세션이 직접 프롬프트와 응답을 주고받을 수 있게 합니다.

<details>
<summary><code>concord setup</code>이 변경하는 내용</summary>

`concord setup`은 로컬 `.concord/` 워크스페이스를 만들고, Claude, Cursor, Gemini, Grok, Codex용 MCP 서버를 등록합니다 (`.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json`, `.grok/config.toml`, `~/.codex/config.toml`). [Goose](./docs/goose.md)가 감지되면 Goose의 `config.yaml`에 `concord-relay` 확장을 등록합니다. [Antigravity](./docs/antigravity.md)의 경우 `.agents/mcp_config.json`, `.agents/hooks.json`, `.agents/rules/concord.md`를 작성합니다. 또한 Concord의 도구 지침을 클라이언트 설정(`CLAUDE.md`, `AGENTS.md`, `.codex/`, `.cursor/rules/`)에 작성합니다. 기존 설정을 대체하지 않고 병합하며, 다시 실행해도 안전합니다.

설정 과정에서는 지원되는 클라이언트도 감지하여 각 클라이언트의 전역 Concord 어댑터 설치를 개별적으로 시도합니다. 이 단계를 건너뛰려면 `--no-adapters`를 사용하고, 지원이 저하되면 실패해야 하는 관리형 설치에서는 `--require-adapters`를 사용하세요. MCP 등록을 직접 관리하면서 워크스페이스와 지침만 작성하려면 `--no-mcp`를 전달하세요.

전역 모드가 켜져 있으면(아래 참조) 사용자 수준 등록이 이미 적용되므로, 설정 과정에서 저장소의 지침 파일과 MCP 파일을 건드리지 않습니다. 팀을 위해 체크인하는 경우처럼 그래도 작성하려면 `--repo-files`를 전달하세요.

</details>

<details>
<summary>아직 설정하지 않은 저장소에서 Concord 사용하기</summary>

`concord setup`을 대화형으로 처음 실행하면, 설정을 실행한 적 없는 저장소에서도 에이전트가 Concord를 사용할지 묻습니다 (기본값: 예). 답변은 `~/.concord/config.json`에 저장되며, `concord setup --global` 또는 `--no-global`로 변경할 수 있습니다.

전역 모드가 켜져 있으면 Concord는 설치된 각 에이전트에 사용자 수준으로 자신을 등록하고, 각 에이전트의 사용자 지침 파일(`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, Goose의 `.goosehints`, `~/.copilot/copilot-instructions.md`, Cursor는 전역 세션 훅을 통해 전달)에 짧은 Concord 섹션을 추가합니다. 해당 저장소에는 아무것도 작성되지 않습니다. 작업 내용은 `~/.concord/global.db`에 저장되며, 저장소마다 프로젝트가 하나씩 만들어지고 Concord Cloud와 동일하게 git remote를 기준으로 이름이 지정됩니다. 어떤 저장소에도 속하지 않는 세션은 `general` 프로젝트를 공유합니다. 설정을 완료한 저장소는 모든 내용을 자체 `.concord/`에 유지하며, 전역 모드가 켜져 있는 동안 그곳에서 `concord setup`을 실행해도 `--repo-files`를 전달하지 않는 한 지침 파일이나 MCP 파일을 작성하지 않습니다. 전역 모드를 끄면 추가했던 내용만 정확히 제거됩니다.

</details>

<details>
<summary>Concord Cloud: 서로 다른 머신의 에이전트</summary>

`concord cloud login`은 이 머신을 Concord Cloud에 로그인시키고 연결합니다. 연결된 머신은 모든 폴더에서 클라우드를 통해 작동하므로, 해당 머신의 에이전트가 어떤 머신의 에이전트와도 통신할 수 있습니다. 머신이 연결되어 있는 동안에는 어떤 저장소도 로컬 상태를 유지하지 않습니다. git remote가 있는 저장소는 해당 remote의 프로젝트가 되고, remote가 없는 저장소는 이 머신에서 독립된 프로젝트가 되며, 저장소 밖의 모든 것은 `general`에 속합니다.

`concord cloud unlink`는 로그인을 유지한 채 머신 전체를 로컬 Concord로 되돌리고, `concord cloud link`는 다시 클라우드로 전환합니다. `concord cloud status`는 현재 어느 쪽이 적용 중인지 알려 줍니다. `concord doctor`는 연결 상태를 확인하고, 머신이 더 이상 사용하지 않는 로컬 상태를 나열하며, 연결 전에 시작된 세션이 모두 종료된 후 이를 다른 곳으로 옮길 수 있는 명령을 함께 보여 줍니다 (아무것도 삭제되지 않습니다).

</details>

## 지원 에이전트

| 에이전트                          | 연동 가이드                                  |
| --------------------------------- | -------------------------------------------- |
| Claude Code                       | [설정 및 전달](./docs/claude-code.md)        |
| Codex                             | [설정 및 전달](./docs/codex.md)              |
| Cursor                            | [설정 및 전달](./docs/cursor.md)             |
| Gemini CLI                        | [설정 및 전달](./docs/gemini-cli.md)         |
| Grok Build                        | [설정 및 전달](./docs/grok-build.md)         |
| Goose                             | [설정 및 전달](./docs/goose.md)              |
| Google Antigravity                | [설정 및 전달](./docs/antigravity.md)        |
| GitHub Copilot CLI                | [설정 및 전달](./docs/github-copilot-cli.md) |
| Devin CLI                         | `concord setup`을 통한 프로젝트 수준 설정    |
| Conductor (Claude Code, Codex)    | [설정 및 전달](./docs/conductor.md)          |
| MCP를 지원하는 기타 코딩 에이전트 | [수동 설정](./docs/other-mcp-clients.md)     |

> 범용 `/concord` 슬래시 명령은 없으며, 명령은 클라이언트마다 다릅니다. Concord는 MCP를 지원하는 모든 클라이언트에서 MCP 도구와 설치된 지침을 통해 작동합니다.

실시간 전달은 수신 측 하니스와 세션 상태에 따라 달라집니다. 설치된 에이전트 중 어떤 에이전트에 도달할 수 있고 메시지가 어떻게 전달될지 확인하려면 `concord adapters status`를 실행하세요.

## 커뮤니케이션은 시작일 뿐입니다

메시징은 에이전트가 대화를 시작하게 합니다. Concord의 공유 작업 상태는 메시지가 전달된 이후의 협업을 안정적으로 유지합니다.

| Concord 없이                                     | Concord와 함께                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| 에이전트가 다른 하니스의 동료에게 연락할 수 없음 | 에이전트가 지원되는 클라이언트 간에 응답 가능한 직접 프롬프트를 보냄 |
| 편집한 후에야 충돌을 발견함                      | 작업을 시작하기 전에 파일과 모듈을 선점함                            |
| 세션이 끝나면 컨텍스트가 사라짐                  | 결정 사항, 가정, 발견 내용이 작업에 계속 연결됨                      |
| 소유권을 채팅 기록에서 짐작해야 함               | 할당과 핸드오프가 명시적이며 수락 확인을 거침                        |
| 사람이 브랜치와 diff에서 진행 상황을 재구성함    | 리뷰 패킷에 범위, 테스트, 위험 요소, 출처가 함께 제공됨              |

Concord는 또 하나의 자율 에이전트나 오케스트레이터가 아닙니다. 하나의 작은 MCP 서버를 통해 접속 상태, 메시징, 작업 메모리, 소유권, 핸드오프, 리뷰 상태를 제공하는, 에이전트를 둘러싼 공유 계층입니다.

## 도구

| 도구            | 용도                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `start_work`    | 접속 상태를 등록하고, 작업 하나를 선점하거나 수락하며, 편집 전에 범위 겹침을 보고                            |
| `inspect_work`  | 워크스페이스/작업 상태, 에이전트 수신함/발신함, 또는 영구 보존되는 프롬프트/응답 스레드를 읽음               |
| `update_work`   | 작업 컨텍스트를 기록하거나, 프롬프트를 받을 수 있는 다른 워크스페이스 에이전트에게 즉시 프롬프트/응답을 보냄 |
| `transfer_work` | 버전이 관리되는 작업을 할당, 수락, 거절, 해제, 재할당, 핸드오프 제안 또는 다시 열기                          |
| `finish_work`   | 증거를 기록하고, 선택적으로 작업을 리뷰 준비 완료, 완료 또는 종료로 표시                                     |

쓰기 오퍼레이션은 `agent_id`를 받으므로, 작업을 하는 것만으로 접속 상태가 유지됩니다. `inspect_work`는 **현재 누가 있는지** 보여 주고 **방치된 선점**, 즉 소유 에이전트가 핸드오프 없이 사라진 활성 선점을 표시합니다.

에이전트 간 실시간 커뮤니케이션을 사용하려면 `concord setup`을 실행한 다음 기존 클라이언트 세션을 한 번 재시작하세요. 프롬프트는 `update_work`에 `operation: "prompt"`, 대상 `to_agent_id`, 내용, `idempotency_key`를 지정해 보내고, 응답은 `operation: "reply"`와 `reply_to_message_id`를 사용합니다. 수신 확인을 지원하는 어댑터는 진행 중인 턴의 방향을 조정하거나 유휴 상태에서 새 턴을 시작합니다. 훅만 지원하는 연동은 나중에 가져갈 수 있는 영구 보존 메시지를 남기고 그 제약을 결과에 명시합니다. 지정된 에이전트에 도달 가능한 엔드포인트가 없으면 전달은 즉시 실패하며, Concord가 몰래 다른 곳으로 경로를 바꾸지 않습니다.

`concord adapters status`는 모니터/컨트롤러 종류, 검증된 도달 가능성, 필요한 조치, 버전 확인 결과를 포함해 각 하니스를 개별적으로 보고합니다. `concord adapters install`, `doctor`, `uninstall`은 저장소 설정과 별개로 동일한 전역 라이프사이클 관리를 제공합니다.

Concord는 저장소 워크스페이스를 자동으로 결정합니다. 클라이언트가 잘못 라우팅된 호출을 감지할 수 있도록 각 오퍼레이션은 `workspace_id`와 저장소 루트를 반환하며, 하나의 서버가 여러 루트를 조율할 때는 이 id를 명시적으로 전달할 수 있습니다.

라이프사이클을 변경하는 오퍼레이션은 작업의 단조 증가 `version`을 `expected_version`으로 사용합니다. 두 에이전트가 같은 버전에 대해 동작하면 첫 번째 전환만 성공합니다. 할당된 작업은 지정된 에이전트가 `transfer_work`를 `action: "accept"`로 호출할 때까지 `assigned` 상태로 유지되며, 핸드오프 제안도 마찬가지로 수신자가 수락할 때까지 소유권이 발신자에게 남아 있습니다. 모든 소유권 변경은 추가 전용 감사 이력에 보존됩니다.

## 제공되는 것

SQLite는 로컬의 단일 진실 공급원이며, 작업이 진행되는 **저장소 루트**의 `.concord/`에 저장됩니다. MCP 서버는 루트를 다음 순서로 결정합니다: 설정된 경우 `CONCORD_REPO_ROOT`, 그다음 Claude Code의 `CLAUDE_PROJECT_DIR` (사용자 범위 서버에서도 Claude Code가 자동으로 설정합니다), 마지막으로 작업 디렉터리입니다. 따라서 한 저장소의 모든 에이전트가 하나의 스토어를 공유합니다. 서버의 작업 디렉터리가 저장소 안에 있지 않은 곳에서 실행할 때는 `CONCORD_REPO_ROOT`를 설정하세요.

연결된 Git 워크트리는 Git의 `commondir` 메타데이터를 따라 기본 체크아웃을 찾으므로, 메인 체크아웃과 연결된 모든 워크트리는 의도적으로 하나의 Concord 데이터베이스와 워크스페이스 id를 공유합니다.

명시적인 워크스페이스 선택을 제한하려면 `CONCORD_ALLOWED_ROOTS`를 경로 구분자로 구분된 허용 저장소 루트 목록으로 설정하세요. 허용 목록이 없어도 디코딩된 루트는 존재하는 디렉터리여야 합니다.

`concord setup`은 `*`가 담긴 `.concord/.gitignore`를 작성하므로, 생성된 워크스페이스는 저장소의 공유 `.gitignore`를 수정하지 않고도 자신을 무시하며 로컬에만 유지됩니다. 일부 산출물을 PR에 포함하려는 팀은 해당 파일에 부정 규칙을 추가하거나(설정 과정에서 기존 규칙은 유지되며 `*` 전체 규칙이 있는지만 확인합니다) 사람이 읽을 수 있는 파일을 강제로 추가할 수 있습니다. Concord 0.10.5 이하에서 설정한 저장소에는 루트 `.gitignore`에 `.concord/` 규칙도 있으므로, `.concord/.gitignore`의 부정 규칙이 적용되려면 먼저 이 규칙을 제거해야 합니다.

```text
.concord/
├── .gitignore          디렉터리 전체를 무시
├── concord.db          로컬의 단일 진실 공급원
├── HANDOFF.md          사람이 읽을 수 있는 핸드오프
├── REVIEW_PACKET.md    리뷰 준비 완료 증거
├── events.jsonl        시간순 도구 이벤트, 한 줄에 JSON 객체 하나
└── WORK_STATE.json     생성된 작업 상태 내보내기
```

## CLI

Concord는 타입이 지정된 MCP 도구와 일반 CLI를 모두 지원합니다. MCP를 지원하는 에이전트는 도구를 직접 호출할 수 있고, 사람과 CLI 중심 에이전트는 `concord` 명령으로 동일한 공유 워크스페이스에서 작업할 수 있습니다.

```bash
concord setup                # 로컬 상태, 지침, MCP 클라이언트 설정
concord status               # 에이전트 목록, 진행 중인 작업, 겹침, 방치된 선점, 리뷰 준비 완료 항목
concord dashboard            # 에이전트, 작업, 알림, 활동을 보여 주는 키보드 기반 실시간 뷰
concord who                  # 접속 중인 에이전트와 각자 진행 중인 작업
concord tasks                # 추적 중인 모든 작업 나열
concord handoff <task-id>    # 최신 핸드오프 출력
concord review-packet <id>   # 최신 리뷰 패킷 출력
concord export markdown      # .concord/ 산출물 재생성
concord check <files...>     # 활성 작업과의 정확한 파일 겹침 확인 (훅/CI용)
concord watch                # .concord가 변경될 때마다 작업 상태 출력 (Ctrl-C로 중지)
concord doctor               # 워크스페이스 점검 + 작업별 도구 도입 현황
concord adapters status      # 전역 하니스 전달 기능 매트릭스

concord --repo ../project status        # 어디서든 저장소 경로로 선택
concord --workspace ws_... status       # Concord 오퍼레이션이 반환한 id로 선택
```

pre-commit 훅이나 CI에서 충돌하는 편집을 차단하려면 `concord check src/file.ts`를 실행하세요 (자신의 작업을 제외하려면 `concord check --task <id> src/file.ts`). 활성 작업이 같은 파일을 선점하고 있으면 명령은 상태 코드 `1`로 종료하고, 겹침이 없으면 `0`으로 종료합니다. Claude Code의 PreToolUse 훅은 종료 코드 `2`를 거부로 처리하므로, 해당 훅에서는 `concord check src/file.ts || exit 2`를 사용하세요.

`--repo`와 `--workspace`는 상호 배타적인 전역 옵션입니다. CLI는 MCP와 동일한 `CONCORD_REPO_ROOT` → `CLAUDE_PROJECT_DIR` → 작업 디렉터리 우선순위와 동일한 연결 워크트리 정규화를 사용합니다.

`concord dashboard`는 읽기 전용 전체 화면 로컬 TUI입니다. 공유 SQLite 워크스페이스에서 매초 새로 고치면서 에이전트, 작업, 알림, 컨텍스트, 타임라인을 고정된 터미널 뷰포트 안에 표시합니다. `Tab`으로 창을 전환하고, `j`/`k` 또는 화살표 키로 작업을 선택하고, `/`로 필터링하고, `?`로 도움말을 보고, `q`로 종료합니다.

## 업그레이드

```bash
npm install -g @concord-ai/concord-mcp@latest
concord --version
```

독립 실행형 설치를 업그레이드하려면 `curl … | sh` 설치 프로그램을 다시 실행하세요.

Concord는 매일 업데이트를 확인하고 CLI, MCP 도구, 대시보드에 사용 가능한 업데이트를 표시합니다. `concord setup`은 확인을 거쳐 업데이트를 설치할 수 있으며(npm 또는 설치 프로그램 중 처음 사용한 방식으로), `CONCORD_NO_UPDATE_CHECK=1`을 설정하면 확인을 비활성화합니다.

## 이 프로젝트의 정체와 범위

같은 로컬 체크아웃을 사용하는 코딩 에이전트를 위한 공유 작업 상태와 작업 메모리입니다. 오케스트레이터, 코드 리뷰 도구, 호스팅 동기화 서비스, 메모리 벡터 DB, 자율 코딩 에이전트가 **아닙니다**.

함께 보기: [왜 그냥 markdown을 쓰지 않나요?](./docs/why-not-markdown.md)

## 기여하기

[`CONTRIBUTING.md`](./CONTRIBUTING.md)와 [`CLAUDE.md`](./CLAUDE.md)를 참고하세요. 이 저장소는 엄격한 타입(`any` 금지, 타입 캐스트 금지)과 모듈식 구조를 따릅니다. 처음 기여하기 좋은 이슈에는 [`good first issue`](https://github.com/Get-Concord-AI/concord-mcp/labels/good%20first%20issue) 라벨이 붙어 있습니다.

## Star 기록

<a href="https://www.star-history.com/?repos=Get-Concord-AI%2Fconcord-mcp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&theme=dark&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <img alt="Star 기록 차트" src="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
 </picture>
</a>

## 개인정보 및 텔레메트리

Concord는 제품 및 협업 조율 텔레메트리를 `getconcord.ai`로 전송합니다. 여기에는 무작위 설치/호출 식별자, 복원 불가능한 설치별 워크스페이스 및 작업 흐름 가명, Concord/Node/플랫폼 버전, 정규화된 클라이언트 메타데이터, 오퍼레이션 이름, 결과, 소요 시간, 집계된 겹침/편집 보호 결과, 메시지 전달 단계와 지연 시간, 작업 라이프사이클 전환과 경과 시간, 명시적으로 보고된 수락, 통합, 사람 개입, 재작업 결과가 포함됩니다.

Concord는 코드, 원시 파일 또는 저장소 경로, remote, 사용자 이름, 원시 작업 또는 에이전트 식별자, 메시지 식별자나 내용, 명령 인수, 도구 입출력, 작업 내용을 절대 전송하지 않습니다. 수신 서버는 요청 IP 주소를 저장하고 이로부터 국가 코드를 도출해 저장합니다. 이러한 서버 측 필드에는 현재 자동 만료가 없습니다. 텔레메트리를 비활성화하려면 `CONCORD_TELEMETRY_DISABLED=1` (또는 `DO_NOT_TRACK=1`)을 설정하세요. 전송은 최선 노력 방식이며 Concord 오퍼레이션을 실패시키는 일은 없습니다.

## 라이선스

[MIT](./LICENSE)
