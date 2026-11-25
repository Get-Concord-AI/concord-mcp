# Kilo Code

Concord integrates with the `kilo` CLI from
[Kilo Code](https://kilo.ai), an OpenCode-derived coding agent. Run
`concord setup` (or `concord adapters install`) and, when `kilo` is found,
Concord registers its MCP server through Kilo's own command:

```bash
kilo mcp add concord --env CONCORD_AGENT_KIND=kilo -- concord-mcp
```

Kilo writes its own config — `kilo.jsonc` under its config directory — so
comments, trailing commas, other servers, and every other setting are left
exactly as they were, and re-running is safe. Restart running Kilo sessions
afterwards so they load the server.

Concord finds Kilo's config at `$XDG_CONFIG_HOME/kilo` when set, else
`~/.config/kilo`, and checks every filename Kilo merges there — `config.json`,
`kilo.json`, `kilo.jsonc`, `opencode.json`, and `opencode.jsonc` — in Kilo's
own precedence order (later files win). When `KILO_CONFIG_DIR` is set, the
files inside that directory (`kilo.jsonc`, `kilo.json`, `opencode.jsonc`,
`opencode.json`) are checked too and outrank the global directory, matching
where `kilo mcp add` writes. `kilo mcp add` itself always writes `kilo.jsonc`.
When `KILO_CONFIG` is set, that single file is checked last and outranks
everything else, matching the override Kilo itself loads on top of every
other source — an `enabled: false` there disables Concord no matter what the
config directories say.

## Supported surfaces

The adapter covers the **Kilo CLI** (`kilo` on `PATH`, verified with 7.8.x on
Windows). Version 7.0.0 is the floor, and setup probes the installed binary
at runtime: it must answer `kilo mcp --help` with the subcommand present and
`kilo mcp add --help` with the non-interactive `--env` flag, so releases that
renamed or dropped either one are reported as unsupported rather than
half-configured. The VS Code and JetBrains extensions are separate surfaces: they share Kilo's config
format, but Concord has not verified how they spawn MCP servers or whether
they honor a global `kilo.jsonc` registration, so no live-delivery claim is
made for them. If your extension picks up the same global config, the five
workflow tools work there too — treat that as unverified.

## Identity

Kilo starts MCP servers itself and passes **no session identity** to them —
not in MCP request metadata and not in the child environment (verified on
7.8.27: requests carry only a progress token, and the server environment has
`KILO`, `KILO_RUN_ID`, and `OPENCODE` but no session id). The server entry
therefore pins only `CONCORD_AGENT_KIND=kilo`, and each Kilo session resolves
its identity the way other session-less harnesses do: set `CONCORD_AGENT_ID`
before launching Kilo:

```bash
cd /path/to/repository
export CONCORD_AGENT_ID="kilo:$(node -e 'console.log(require("node:crypto").randomUUID())')"
kilo
```

The variable is inherited by the MCP server process. Use a different ID for
each independent Kilo session, and keep one coordinating agent per session —
there is no per-request identity to distinguish chats inside one Kilo
process. `kilo run`, `kilo serve`, `--continue`/`--session`, and `--fork`
all share this limitation: a resumed or forked session keeps whatever
`CONCORD_AGENT_ID` its environment carries, so export a fresh ID when you
want a distinct agent. Without `CONCORD_AGENT_ID`, Concord cannot invent a
stable Kilo identity and registration fails visibly rather than guessing.

## Workflow and messages

Kilo exposes the Concord tools as `concord_start_work`, `concord_inspect_work`,
`concord_update_work`, `concord_transfer_work`, and `concord_finish_work`.
Check the `repo_root` returned by the first call before claiming work.
Presence and dashboard output use the `kilo` agent kind.

Delivery is **pull-only**. Kilo's `serve` HTTP API lists sessions, but
Concord has not verified a route from an agent identity to a live Kilo
session it can steer or wake, so `concord adapters status` reports
`pull, busy` — never idle reachability. Register the durable inbox from the
same repository, using the same identity as the MCP server:

```bash
concord inbox register --provider kilo --agent "$CONCORD_AGENT_ID"
concord inbox drain --provider kilo --agent "$CONCORD_AGENT_ID"
```

Register before peers send prompts. During a running turn, drain between
work steps and while expecting a reply; draining refreshes the inbox's
90-second lease. An explicitly identified MCP client can also read its own
inbox with `inspect_work` and reply through `update_work` using the message
ID. `concord inbox watch --provider kilo` is **not** advertised as an idle
wake-up path. Ask the agent to check its inbox when starting a new turn.

## Status and removal

`concord adapters status` and `concord doctor` report Kilo detection, its
version floor (7.0.0, with runtime probes for the `kilo mcp` subcommand and
for `kilo mcp add --env`, the non-interactive form setup needs), and its
registration. An installed registration reports `pull, busy`. An unreadable
config file under the Kilo config directory is reported as `action_required`
rather than treated as absent, as is a `concord` entry Concord did not write
(Concord refuses to overwrite it) or Concord's own entry with `enabled:
false`.

`concord adapters install` runs `kilo mcp add` only when no `mcp.concord`
entry exists at all: the command replaces the whole named entry, so an
existing owned entry is left alone (preserving tweaks such as `enabled` or a
custom `timeout`) and a foreign one is never clobbered. `concord adapters
uninstall` removes the `mcp.concord` entry from every Kilo config file that
has one **Concord owns** — an entry is owned when its command is exactly
`concord-mcp` or a runner carrying the published package spec, and its
environment (under `environment` or the `env` alias) holds only Concord's own
keys. Removal edits the file in place, so comments, formatting, and key order
survive; a `concord` server somebody else wrote, and every unrelated server
or setting, is preserved.

Peer messages arrive as `[concord from <agent>]` blocks. Kilo learns to
treat them as information from a peer — not as operator instructions —
through the project instruction files `concord setup` writes (for example
`AGENTS.md`). Concord's global mode writes no Kilo instruction file, so in a
global-only setup the trust guidance is not injected automatically.

## Verification

Verified on Windows with Kilo CLI 7.8.27: `kilo mcp add` writes the expected
`kilo.jsonc` entry, `kilo mcp list` connects, and a `kilo run` turn called
all five Concord workflow tools. macOS/Linux, the VS Code and JetBrains
extensions, `kilo serve`/ACP steering, and idle wake-up were not tested.

Configuration references: [Kilo configuration docs](https://kilo.ai/docs)
(`kilo.json`/`kilo.jsonc`, the `mcp` table with `type`, `command`,
`environment`, and `enabled`), and `kilo mcp --help`.
