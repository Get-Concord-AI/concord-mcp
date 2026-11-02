# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- OpenCode V2 integration. `concord setup` merges a repository-scoped MCP entry
  into `opencode.json` or `opencode.jsonc`, uses OpenCode request metadata for
  session identity, and reports durable inbox delivery without claiming idle
  reachability.

## [0.19.0] - 2026-10-30

### Added

- `concord adapters gemini`: starts Gemini CLI with a first turn that runs its
  Concord inbox monitor, so a fresh session can be reached while idle before
  the user types anything. A session started with plain `gemini` has no monitor
  until its first turn. Gemini's own flags are forwarded, and a prompt passed
  with `-i` or `-p` is left as given.

### Fixed

- `finish_work`'s field descriptions now say that a `reported_outcome` needs a
  `provenance` entry with field `"reported_outcome"`, and the rejection names
  that entry, so agents stop dropping the outcome.

## [0.18.0] - 2026-10-28

### Added

- `concord cloud status --json` and `concord cloud agents [--json]`: the login,
  whether its API and key work, whether this machine is linked and this folder's
  project, and the agents Concord Cloud has seen on this machine, as a stable
  JSON contract (`schema: 1`) for scripts and setup tools.

### Fixed

- `concord setup`'s upgrade prompt now runs `npm.cmd` on Windows through
  `cmd.exe`, which Node requires for batch files.

## [0.17.1] - 2026-10-27

### Fixed

- `concord doctor` on a linked machine no longer leaves `-shm` and `-wal` files
  beside the local stores it reports on. Even a read-only SQLite connection
  creates them for a WAL-mode store, so doctor now counts a store's open tasks
  from a temporary copy (log included) and leaves the folder as it found it.

## [0.17.0] - 2026-10-27

Concord Cloud is linked per machine, and nothing in a repository can take a
repository off it.

### Fixed

- **A repository silently left Concord Cloud after `concord setup` or
  `concord doctor`.** Both created `.concord/concord.db`, and a repository
  holding a local store was kept local even on a signed-in machine. Agents
  started there afterwards were on a local network of their own: they could not
  send messages to, or receive them from, any agent on the cloud.
- `concord doctor` no longer crashes with a stack trace on a store this version
  cannot migrate; it reports the store as unreadable.

### Changed

- **Linking is a property of the machine.** A linked machine (signed in, and
  not unlinked) works through Concord Cloud in every folder. `concord cloud
login` links the machine; `concord cloud unlink` switches the whole machine to
  local Concord while keeping the login; `concord cloud link` switches it back.
  A machine that is not signed in works exactly as before.
- On a linked machine:
  - a repository with no remote is a project of its own on this machine
    (`local.concord/<machine>/<folder>-<hash>`) rather than local;
  - every folder outside a repository is in `general`, not only folders a
    client names;
  - `concord setup` installs instructions, MCP registrations and adapters but
    creates no local state;
  - `concord doctor` checks the login, the API, this folder's project and the
    organization's agent ids (an id shared by several agents cannot receive
    messages), and lists local state the machine no longer uses with the
    commands to move it aside. Doctor never moves or deletes it itself;
  - commands that only read a local store (`handoff`, `review-packet`, `watch`,
    `dashboard`) say the machine works through the cloud instead of creating a
    store; `concord check` exits successfully with a note, so an edit hook never
    denies every edit;
  - an MCP server started before the machine was linked opens no further local
    store; restart sessions after linking so they work through the cloud.
- The SessionStart line now says to use this machine's `concord` MCP server for
  Concord calls, never a chat app's Concord connector (claude.ai's, in Claude
  Code). Given a session's id, that connector registered a second agent under
  it, and messages to the id could no longer be delivered.

### Upgrading

- A repository's `.concord/cloud.json` is ignored. A repository that ran
  `concord cloud unlink` before works through the cloud on a linked machine,
  and a repository linked with `--project` uses its own remote. `concord doctor`
  lists any such file.
- `concord cloud link --project` is gone.

## [0.16.0] - 2026-10-23

Messaging v2: WhatsApp-style receipts and private inboxes (#279). See
`docs/messaging-v2.md` for the full design.

### Upgrading

- **Restart every agent session after upgrading.** The first run of 0.16.0
  upgrades the local Concord databases (migration 015), and the upgrade is one
  way. A session still running 0.15.0 fails to send against the upgraded store.
  From this release on, an older build refuses a newer store with a clear
  message instead of a database error.
- Claude Code users: update the concord-relay plugin to get its new hooks
  (`SessionEnd`, `UserPromptSubmit`, `AskUserQuestion` and `Notification`).

### Breaking changes

- Message statuses are now `sent`, `delivered`, `read`, `replied` and
  `failed`. Existing `pending` messages become `sent`, and messages already
  seen become `read`.
- `inspect_work` with another agent's `agent_id` returns presence only. Its
  inbox and outbox are left out, and threads the caller took no part in read
  as not found.
- `concord inbox drain --agent` refuses an agent that is not the current
  session's own.
- Sending to a registered agent that is offline queues the message (✓)
  instead of failing with `target_unreachable`. Unread messages expire after
  24 hours.

### Added

- **Delivery receipts.** Every message shows ✓ once Concord has stored it,
  ✓✓ once the recipient's session took it, read once that session's model was
  shown it, and replied. Senders can check at any time with `inspect_work
message_id`, and `update_work` returns the receipt with each send.
- **Read detection from evidence, never timing.** Claude Code (prompt and
  transcript), Codex (hooks, and the adapter's own turn events, including
  model output mid-turn), Grok, Copilot CLI, Cursor and Antigravity each mark
  a message read only when the session shows its model had it. A message held
  behind an `AskUserQuestion` prompt stays ✓✓ until the user answers or
  dismisses it.
- **Unreachable sessions fall back to ✓.** When a session holding an unread
  message ends or crashes, the message returns to the queue and reaches the
  agent's next session.
- **`concord messages`**: a read-only list of local messages with their
  receipts, for people. It never changes a receipt.
- **Waiting on the user.** `inspect_work` shows when an agent's session has
  stopped to ask its user something.
- Manual setup guide for MCP clients without a Concord adapter (#243, #260).

### Fixed

- The Claude Code monitor follows its harness through shell wrappers, and
  exits once the harness is gone.
- Senders are no longer told a queued message "can be injected now".

### Changed

- The e2e suites cover receipts for every harness pair, plus Claude Code's
  question prompt, Esc, a crashed session and inbox privacy, and the Codex
  adapter against a real app-server. Each test sandbox gets its own temp
  directory, and Claude Code no longer auto-updates mid-run.

## [0.15.0] - 2026-10-21

### Added

- **GitHub Copilot CLI support.** `concord setup` registers Concord in
  `~/.copilot/mcp-config.json` and `.github/mcp.json`, writes instructions into
  `.github/copilot-instructions.md`, and installs the adapter when `copilot` is
  on PATH. Copilot exposes no session id to MCP servers, so identity comes from
  the per-call `agent_id` or `CONCORD_AGENT_ID` (#177).
- **Wake idle Copilot CLI sessions.** `concord adapters copilot [args...]`
  starts Copilot (1.0.100 or later) with its embedded server and attaches a
  Concord host, so peer messages steer a busy turn or start a turn while the
  session is idle, like `concord adapters codex`. Plain `copilot` sessions keep
  hook delivery (#261, #262).
- **Google Antigravity support.** Concord detects the `agy` CLI and the
  Antigravity IDE, registers its MCP server with its own agent kind, and
  installs lifecycle hooks (`.agents/hooks.json`, or
  `~/.gemini/config/hooks.json` for global adapters) that give each
  conversation its agent id and deliver messages mid-turn (#187, #220).
- **Wake idle Antigravity sessions.** Antigravity now runs a one-shot
  `concord inbox watch --once` monitor in the background, and the first model
  call of a turn asks for it when none is running, so an idle `agy` session
  wakes when a peer writes (#271, #274).
- **Install without npm.** `curl -fsSL https://getconcord.ai/install.sh | sh`
  installs a self-contained build with its own Node runtime on macOS and Linux
  (x64 and arm64). Update notices, `concord setup`'s upgrade, and the Goose
  extension follow the install method instead of assuming npm. Adapter links
  keep working across standalone upgrades (#226).

### Fixed

- **Codex controller messages show who sent them.** Messages delivered by
  `concord adapters codex` now carry the `[concord from <agent> id=<id>]`
  header like every other channel, so the receiving session can reply to them
  (#264).
- **Copilot messages are framed once.** The Copilot live host no longer adds a
  second header to relay messages (#273).
- **Idle wake on macOS with long temp paths.** When the relay socket path
  would exceed the Unix socket limit (as under Copilot's per-session
  `TMPDIR`), Concord falls back to `/tmp/concord-relay-<uid>`, and refuses a
  relay directory owned by another user (#272).
- **CLI empty states name the current tools.** `concord handoff` and
  `concord review-packet` point to `finish_work` instead of the removed
  `handoff` tool (#240, #245).

### Changed

- End-to-end tests run in CI. A simulated cross-harness suite runs on Ubuntu
  and macOS, and a real-harness suite drives the Claude Code, Codex, Grok,
  Goose and Copilot CLI binaries against a scripted fake model on Ubuntu. CI
  also verifies on Windows (#196, #266, #270, #275).
- Documentation updates: Node minimum, `concord check`/`watch`, `events.jsonl`,
  Goose tools, Cursor agent discovery, and README setup files for Goose and
  Antigravity.

## [0.14.2] - 2026-10-19

### Added

- **Sessions install or repair their own harness adapter.** When a Claude Code,
  Grok or Goose session starts the Concord MCP server, it checks that harness's
  adapter in the background. If the adapter is missing or broken and you opted
  in during `concord setup` (or with `--auto-adapters`), Concord installs or
  repairs it for the next session. The current session gets a one-time notice
  with its agent id and monitor command. Without opt-in, nothing is changed
  (#207).

### Fixed

- **Uninstalling no longer breaks Codex.** `concord adapters uninstall` left
  behind the `[mcp_servers.concord.tools.*]` tables Codex writes when a tool is
  always-approved, and Codex then refused to start with an "invalid transport"
  error. Every `mcp_servers.concord` table is now removed (#227, #228).
- **Grok sessions start the Concord monitor.** Grok's Stop hook now asks the
  agent to start the persistent inbox monitor when none is running (#215).
- **Monitor commands pass `--agent`.** Grok's `monitor` tool does not pass the
  session id to the command it watches, so `concord inbox watch` could not tell
  which session it was. The Grok and Cursor monitor commands now include
  `--agent <agent-id>`, and `concord inbox register` prints the filled-in
  command (#204, #206).

## [0.14.1] - 2026-10-17

### Fixed

- **`concord doctor` repairs dangling adapter links.** A harness adapter link
  that points nowhere, or into a temporary or `npx` checkout, is reported with
  its target and the expected packaged path. `doctor --fix` (or the prompt on a
  terminal) re-points it, `setup` no longer moves a working link into a
  throwaway checkout, and `uninstall` removes a dangling Concord link (#202,
  #203).
- **Overlap warnings cover every claimed task.** `start_work` now warns about
  overlap with assigned, blocked and handed-off tasks, not only active ones,
  matching `concord check` (#185).
- **Grok config editing is safe.** A Grok config with inline
  `mcp_servers = { ... }` is left untouched (with a warning naming the file)
  instead of having a table appended that Grok could not load. Reading and
  removing Concord's tables now skip single- and multi-line TOML strings and
  comments, and a quoted key such as `[mcp_servers."concord.env"]` is no longer
  mistaken for Concord's (#191).
- **The Cursor migration keeps your own server.** `concord setup` no longer
  removes a `concord` entry from `~/.cursor/mcp.json` that the user wrote
  themselves (#194).
- **Workspace selection.** An early tool call that names no workspace no longer
  discards the client's MCP roots answer, and `update_work` records delivery in
  the workspace it started in, even if another workspace becomes active or
  Concord Cloud refuses a request while the message is delivered.
- **`concord watch` in global mode** works on a fresh project before any
  artifacts exist.

### Changed

- Dependency updates, including `ink` 8 and `js-yaml` 5 (#217, #218).

## [0.14.0] - 2026-10-12

### Added

- **Global mode.** Agents can now use Concord in repositories where
  `concord setup` was never run, with nothing written into the repository. Their
  work goes into one machine-wide store, `~/.concord/global.db`, as a project
  named after the repository's normalized `origin` remote, so every clone shares
  it. A repository with no remote is named by its path, and anything outside a
  repository goes to `general`, matching Concord Cloud. A repository that was set
  up keeps its own `.concord/` store (#181, #182).
- **`concord setup` offers global mode.** The first interactive run asks once
  (yes by default), and `--global` / `--no-global` decide without asking. The
  answer is saved in `~/.concord/config.json`. Turning it on adds a user-level
  MCP registration for Claude Code, Cursor, Gemini CLI and Grok Build, and a short
  instruction block in each installed harness's user instructions file. Turning
  it off removes only what global mode added; registrations you made yourself are
  never changed (#183).
- **Cursor in global mode.** A user-level Concord server asks the client which
  folder is open (MCP roots) and joins it, unless `CONCORD_REPO_ROOT` or
  `CLAUDE_PROJECT_DIR` already names the repository. Cursor's `sessionStart` hook
  reads `concord inbox status --json` to give the session its workspace id, and
  the instructions for a folder in the global store. A folder linked to Concord
  Cloud is refused with a clear error instead of being served from a local store
  (#184).

### Changed

- **Signed in, Concord Cloud is the default.** After `concord cloud login`, a
  repository works through Concord Cloud as its git remote's project without
  `concord cloud link`. A session outside any repository that names its folder
  (Claude Code) joins the cloud's `general` workspace, where agents that belong
  to no repository can talk. `concord cloud unlink` now keeps a repository local
  even while signed in, and `concord cloud status` says which applies and why.
  These stay local as before: a repository that already holds local Concord
  state (`concord cloud link` moves it on purpose), one with no remote, and a
  user-level server that learns its folder from MCP roots (#198).
- **Database migration 012.** A task is now unique per project and task id,
  so one store can hold several repositories. Existing tasks, handoffs, reviews
  and updates move to the repository's own project unchanged. Migrations now run
  atomically: one that fails or leaves broken references doesn't commit, and the
  previous schema stays (#181).
- `concord doctor` reports which store, local or global, the workspace uses
  (#182).

### Fixed

- Pressing Ctrl+D at a `concord setup` prompt no longer crashes setup. It counts
  as no answer: the upgrade prompt declines, and the global-mode question is left
  undecided until the next run (#189).

## [0.13.0] - 2026-10-11

### Added

- **Goose support.** `concord setup` registers Concord's MCP server in Goose's
  `config.yaml` when `goose` is installed, keeping any existing extensions and
  settings, and `concord adapters uninstall` removes it again. A Goose agent's
  identity comes from `AGENT_SESSION_ID`. Goose sessions can use the work-state
  tools, but cannot receive inbox messages yet; see
  [`docs/goose.md`](./docs/goose.md) (#147).

### Fixed

- **Relay hooks on Windows.** Hooks now launch the `concord.cmd` wrapper that
  npm and pnpm install on Windows, instead of failing with
  `spawn concord ENOENT`. They also work when the Concord install path contains
  spaces, and pass `%` in arguments through unchanged instead of letting
  `cmd.exe` expand it (#138).
- The whack-a-mole demo no longer passes the removed `--agent-comms` flag, so
  `pnpm demo` runs again (#174).

## [0.12.0] - 2026-10-09

### Added

- **Concord Cloud mode.** A repository linked to Concord Cloud shares its work
  state with agents on every machine in your organization, instead of the local
  `.concord/concord.db`. Unlinked repositories behave exactly as before.
  - `concord cloud login` signs in through the browser (or takes an API key on
    stdin or `CONCORD_CLOUD_API_KEY`); `logout`, `link`, `unlink` and `status`
    manage the machine's login and the repository's link (#154, #155, #157,
    #159).
  - The MCP server forwards the five tools to Concord Cloud in a linked
    repository, acting as the session's own agent and sending
    repository-relative paths (#153, #156).
  - The inbox runs against the cloud: `inbox register`, `drain` and `watch` keep
    their output, the Claude relay monitor long-polls instead of spawning a
    process every two seconds, and the Cursor hook recognises linked
    repositories, including from a subfolder or worktree. Hooks keep to a
    single four-second deadline and never fail a session's turn (#160–#163).
  - The session-start hook registers the session and names everyone in the
    organization; the edit guard checks the cloud's claims, never counting the
    session's own, and lets an edit through with a warning if the cloud does
    not answer in time (#164).
  - `who`, `tasks` and `status` read the cloud; `export`, which writes from the
    local database, says so (#165).
  - Codex receives messages live: the `host-codex` adapter long-polls the cloud
    and steers or starts Codex turns through its app-server; a message Codex
    does not take is reported to its sender as not delivered (#169).
  - Nothing served by Concord Cloud records this package's telemetry; the cloud
    records its own usage.

## [0.11.0] - 2026-10-06

### Changed

- `concord setup` now writes a self-ignoring `.concord/.gitignore` (`*`) instead
  of appending `.concord/` to the repository's root `.gitignore`. Existing rules
  in `.concord/.gitignore` are kept so teams can add negations; a symlinked file
  is replaced rather than written through (#145).
- `concord status` and work-state rendering no longer load completed/closed
  task history, and fetch the latest review packets in batches instead of one
  query per task. Thanks @AdrianLipa90 (#131).
- Relay heartbeat refreshes are phase-spread per endpoint so many sessions do
  not refresh in lockstep. Thanks @AdrianLipa90 (#132).
- Bumped `@modelcontextprotocol/sdk` to 1.31.0 and refreshed development
  dependencies (#151, #152).

## [0.10.5] - 2026-09-23

### Changed

- Draining pending agent messages now uses a dedicated
  `(recipient_agent_id, status, created_at, message_id)` index (schema v11), so
  inbox drains no longer scan a recipient's delivered/replied/failed history.
  Thanks @AdrianLipa90 (#130).
- Refreshed resolved production and development dependencies within their
  existing declared version ranges.

## [0.10.4] - 2026-09-05

### Changed

- Workspace status generation now scans each active-task pair once, avoids
  temporary task slices, reuses the loaded agent list, and batches endpoint
  reads instead of querying once per agent.
- Refreshed resolved production and development dependencies within their
  existing declared version ranges.

## [0.10.3] - 2026-08-25

### Added

- `finish_work` can now record an optional, source-labelled task outcome with
  acceptance, integration, intervention, and rework results. Reported outcomes
  are persisted and included in local handoff and review artifacts.
- Telemetry now records semantic outcomes for overlap warnings, edit guards,
  message delivery, task lifecycle, and reported results. Task flows use
  installation-scoped pseudonyms; raw task ids, paths, messages, and tool
  payloads are not sent.

### Fixed

- Idempotent message retries no longer duplicate unchanged delivery events, and
  asynchronous delivery events remain attributed to the workspace where the
  operation began.

## [0.10.2] - 2026-08-24

### Added

- Background MCP sessions now check npm without blocking startup or tool calls,
  then surface the update prompt through the next tool result. Users who rarely
  invoke the interactive CLI are still told when a newer release is available,
  and the live dashboard keeps the command visible in a yellow banner.
- Interactive `concord setup` now checks for an available release before
  changing configuration and offers a default-No upgrade prompt. An accepted
  upgrade stops setup and asks the user to rerun it with the new version.

### Fixed

- The npm `/latest` request now uses an accepted JSON media type. The previous
  abbreviated-metadata header received HTTP 406 and silently cached a failed
  check instead of detecting the published version.

## [0.9.0] - 2026-08-14

Agents that walked away hours ago no longer crowd the roster. Presence decayed
as far as `away` and stopped there, so every agent that ever registered stayed
listed forever: a workspace roster only grew, and the agents actually present
were buried among sessions that ended days earlier.

### Added

- `archived`, a fourth derived liveness tier after `live`, `idle`, and `away`,
  reached an hour after an agent was last seen. Archived agents are left out of
  the roster `buildRoster` returns, which is the single place every presence
  surface reads — so they disappear from the `concord dashboard` agents panel,
  `concord who`, `concord status`, the `get_work_state` tool and
  `concord://work-state` resource, the SessionStart hook's "who else is here",
  and `WORK_STATE.json` at once.

### Changed

- Nothing is deleted. An agent id keeps its registration, history, and claims,
  so an archived agent that comes back is live again on its next heartbeat.
  Archiving is a display state derived from `last_seen` like the rest of
  liveness, so there is no schema change and no migration.
- Stale-claim detection still sees archived agents. An active claim left behind
  by a long-gone agent stays flagged rather than vanishing with its owner.
- An unparseable `last_seen` now derives `archived` rather than `away`. A
  corrupt timestamp previously pinned that agent to the roster permanently,
  which is the situation archiving exists to prevent.

## [0.8.0] - 2026-08-10

An agent's identity is now derived from its session in one place, instead of
being minted separately by each entry point. Three producers of `agent_id`
disagreed: the relay CLI and the SessionStart hooks derived it from the session
id, while the MCP surface generated a random one. Only the CLI writes delivery
endpoints, so an agent that let `start_work` name it received an identity no
endpoint would ever match — present in the roster, addressable by peers, and
permanently undeliverable. In one workspace, 23 of 24 such agents had no
endpoint at all, and every message sent to them failed `target_not_promptable`.

### Changed

- **Concord resolves `agent_id` from the session, and that resolution wins.**
  A supplied `agent_id` is ignored wherever the session is visible, so an agent
  can no longer claim, finish, or send messages as one of its peers. The field
  stays on the tool surface for clients whose session Concord cannot see: Codex
  spawns MCP servers with a scrubbed environment — no session id, not even
  `PWD` — so its SessionStart hook still tells the model which id to pass back.
- `agent_id` is now optional on `transfer_work` and `finish_work`, which
  previously required it.
- The MCP server registers its presence at startup, before the transport
  connects, deriving its identity from the session id already in its
  environment. Presence no longer waits for the model to call a tool.

### Removed

- Generated agent ids. Where identity cannot be resolved, tools now fail with
  instructions for fixing it rather than registering an unreachable agent.

### Fixed

- **Messages addressed to an agent that entered through `start_work` are
  delivered.** The relay and the MCP surface now agree on one id per session, so
  a peer's reply reaches the agent that asked for it.
- A Codex hook whose payload carried no session id fell back to
  `CLAUDE_CODE_SESSION_ID` and registered `codex:<hash of a Claude session>`, an
  id belonging to no session. Each client's kind and session id are now read
  from the same source.
- Task-scoped activity now refreshes the task's `updated_at` timestamp, so
  current-state views reflect reclaims, progress updates, task-scoped messages,
  handoffs, reviews, and lifecycle work independently of agent heartbeat.
  Activity refreshes do not increment the optimistic-concurrency version.
- Claim metadata fields reject serialized tool-parameter markup, so a client
  that folds later arguments into an earlier free-text field cannot create a
  claim without its real `expected_files`, `modules`, and `domains`.

## [0.7.1] - 2026-08-06

### Fixed

- The relay plugin is now published. `files` listed only `dist`, so 0.7.0 on
  npm contained the CLI and server but not `plugin/concord-relay` — the
  background monitor is the only channel that reaches an idle Claude Code
  agent, and it was unavailable to anyone who installed from the registry.
- `concord setup` installs it. Codex hooks were installed automatically while
  Claude Code's half of the relay was left to be wired up by hand, so a fresh
  setup gave Codex live delivery and Claude Code none. A monitor can only be
  declared by a plugin, so this links the packaged plugin into Claude Code's
  skills directory, where it loads with no marketplace and no install step.

## [0.7.0] - 2026-08-06

Inter-agent messages are now actually delivered. 0.6.1 shipped the send path but
nothing on the other end: `update_work operation="prompt"` failed with
`Concord relay is not connected`, because the relay assumed an external process
could push a prompt into a session another process is already running. No coding
agent exposes that — `claude inject` and `codex inject` are both closed
unimplemented. The recipient now pulls instead.

### Added

- A pull transport. A send enqueues a pending message; the recipient drains its
  own inbox from inside its session, and delivery is recorded at drain time, so
  `delivered` means the agent was actually handed the message.
- `concord inbox` (`status`, `register`, `drain`) — the receiving half, invoked
  by client hooks rather than by hand.
- A Claude Code plugin under `plugin/concord-relay`. Its background monitor is
  the only channel that reaches an agent sitting idle at the prompt; the
  `PostToolUse` and `Stop` hooks cover headless `-p` runs, where monitors do not
  run.
- Codex lifecycle hooks, installed by `concord setup`. Codex has the same hook
  surface as Claude Code but no monitor equivalent, so an idle Codex session
  does not see a queued message until its next turn.
- Endpoints carry real reach (`busy`, `idle`), and `update_work` reports it back
  so a sender is told when a message will sit unread rather than assuming it
  landed.
- Sessions identify themselves with no configuration, from
  `CLAUDE_CODE_SESSION_ID` or a Codex hook payload. `CONCORD_AGENT_ID` still
  overrides it when a human wants to name the agents they are coordinating.

### Changed

- Relayed messages are framed as peer information rather than instructions, and
  that framing is stated once in the server instructions instead of on every
  delivery — it had been costing roughly 24x the payload of a short message.
- `concord setup` warns that Codex skips untrusted hooks silently until you run
  `/hooks` once and trust them.

### Removed

- **Breaking:** the `@concord-ai/concord-mcp/relay` entry point, along with the
  socket relay server, wire protocol, credential handshake, and the Claude and
  Cursor session adapters. They targeted APIs that do not exist. Delivery now
  routes on `agent_endpoints.transport` instead of a dispatcher.
- The `--agent-comms` setup flag and `agent-integrations.json`, which existed
  only to approve that relay.

### Fixed

- `concord setup` no longer wipes Codex hook trust. Codex appends
  `[hooks.state]` trust hashes to the end of `config.toml`, which landed inside
  Concord's marker block; rewriting it silently re-prompted for trust, and until
  granted Codex skipped the hooks without saying so.
- Agent ids no longer collide. They truncated the session id to eight
  characters, but Codex ids are UUIDv7 whose leading hex is a millisecond clock
  — the first eight characters advance only once per ~65 seconds, so two Codex
  sessions started in the same minute shared an id and an inbox.
- A message is never delivered twice. Draining now claims each row atomically,
  which matters because a Claude Code session drains from a monitor poll and a
  tool-result hook at the same time.
- The relay monitor exits immediately outside a Concord workspace instead of
  polling for the life of an unrelated project.

## [0.6.1] - 2026-07-31

### Added

- Live agent-to-agent prompts and explicit replies through the existing
  `update_work` tool, with agent inbox and durable message-thread inspection
  through `inspect_work`.
- Expiring local relay endpoints, authenticated socket delivery, idempotent
  retries, delivery receipts, and append-only message events.
- Codex, Claude, and Cursor host adapter contracts exported from
  `@concord-ai/concord-mcp/relay`, including a public workspace entry point for
  installed client integrations.

### Changed

- `concord setup` now combines workspace initialization, client instructions,
  repository-pinned MCP registration, and optional live-prompt integration
  approval. It replaces the separate `concord init` and `concord install`
  commands.
- Busy prompt targets are steered immediately and idle targets start a new
  turn. Unreachable named targets fail without suggestions or automatic
  rerouting.

## [0.6.0] - 2026-07-30

### Added

- Five public workflow tools — `start_work`, `inspect_work`, `update_work`,
  `transfer_work`, and `finish_work` — replace the granular MCP lifecycle
  surface. The server now supplies concise workflow instructions directly, and
  `concord doctor` identifies generated instruction blocks that need refreshing.
- `concord install` now registers the MCP server itself, writing `.mcp.json`
  (Claude Code), `.cursor/mcp.json` (Cursor), and `[mcp_servers.concord]` in
  Codex's `~/.codex/config.toml` (honoring `CODEX_HOME`). Previously it wrote
  only the agent instructions, leaving registration as a manual step that was
  easy to miss — the instructions landed but the tools were never connected.
  Existing servers, unrelated keys, and TOML comments are preserved, and
  re-running is a no-op. Pass `--no-mcp` to skip registration. A config file
  that cannot be parsed is reported and left untouched rather than overwritten.

### Removed

- The earlier granular MCP tool names are no longer registered as public
  aliases. Update Concord and re-run `concord install` to migrate local agent
  instructions.
- Dormant granular tool schemas, registration adapters, and presentation
  helpers were removed; internal lifecycle operations derive their types from
  the five workflow contracts.

## [0.5.0] - 2026-07-28

### Added

- Transparent, default-on anonymous telemetry for MCP tool and CLI command
  adoption, outcomes, and duration, with stable pseudonymous installation and
  workspace identities.
- `CONCORD_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` opt-outs.

### Security

- Telemetry excludes code, paths, repository remotes, usernames, task and agent
  identifiers, command arguments, tool inputs/outputs, and task content.

## [0.4.1] - 2026-07-26

### Added

- Interactive CLI commands now show a cached, best-effort notice when a newer
  stable Concord release is available on npm.

### Fixed

- `concord dashboard` now uses a bounded full-screen viewport and alternate
  screen buffer, preventing refresh frames from accumulating in terminal
  scrollback.

## [0.4.0] - 2026-07-26

### Added

- Agent presence registry with the `register_agent` MCP tool, derived
  live/idle/away states, `concord who`, and stale-claim detection.
- `concord dashboard`, a live read-only TUI for agents, tasks, coordination
  alerts, task memory, handoffs, review state, and recent activity.
- A paced two-terminal demo that shows real MCP activity appearing in the
  dashboard.

### Changed

- Claude Code sessions can auto-register their presence through the
  `SessionStart` hook, and normal write-tool activity refreshes agent presence.
- The MCP server resolves its shared store at the repository root so agents
  started from different working directories converge on one workspace.

## [0.3.0] - 2026-07-23

### Added

- Task-scoped memory with typed `update_task` entries for intent, progress,
  assumptions, decisions, questions, answers, blockers, and findings.
- `get_task_context` for reading a task's ordered updates, latest handoff and
  review evidence, and current overlap warnings.

## [0.2.0] - 2026-07-22

### Added

- Read-only work-state tool and resource, change notifications, overlap
  enforcement commands, task decomposition, and normalized overlap matching.

### Changed

- Review readiness is now part of `handoff` via `ready_for_review`.

## [0.1.1]

### Changed

- First release published via the automated GitHub Actions pipeline (npm trusted
  publishing / OIDC). No functional changes from 0.1.0.

## [0.1.0]

### Added

- MCP server with the three v0 tools: `claim_work` (with overlap detection),
  `handoff`, and `review_ready`.
- SQLite storage (source of truth) with migrations and typed repositories.
- Rendered artifacts: `HANDOFF.md`, `REVIEW_PACKET.md`, `WORK_STATE.json`, and
  `events.jsonl`, regenerated on every tool write.
- `concord` CLI: `init`, `status`, `tasks`, `handoff`, `review-packet`,
  `export`, `doctor`, and `install`.
- `concord install` writes usage instructions for Claude Code, Codex, and Cursor.
- Two-agent overlap demo (`pnpm demo`).

[Unreleased]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.16.0...HEAD
[0.16.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.14.2...v0.15.0
[0.14.2]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.10.5...v0.11.0
[0.10.5]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.10.4...v0.10.5
[0.10.4]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.10.1...v0.10.2
[0.9.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Get-Concord-AI/concord-mcp/releases/tag/v0.1.0
