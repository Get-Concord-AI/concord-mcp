# OpenCode V2

Concord supports OpenCode V2.0 and newer. OpenCode V1 is not supported by this
integration because it does not provide the request metadata Concord uses for
session identity.

## Setup

Install Concord, open the repository in OpenCode, and run:

```sh
npm install -g @concord-ai/concord-mcp
concord setup
```

When OpenCode V2 is on `PATH`, setup adds a repository-scoped `concord` MCP
server to `opencode.json` or `opencode.jsonc`. It preserves existing settings
and JSONC comments. If both files exist, setup uses the one that already
contains a Concord entry; it reports an ambiguous duplicate instead of editing
both. It also writes Concord's instructions into `AGENTS.md`, which OpenCode
loads from the repository.

The config contains no machine-specific repository path, so it can be shared
with the project. Restart OpenCode after setup so it loads the MCP server.
`concord setup --no-mcp` skips client registration. `--no-adapters` skips
global adapter installation but still registers the repository MCP server.

## Identity and tools

For each MCP request, OpenCode V2 supplies its opaque session ID in request
metadata. Concord hashes that ID into a stable `opencode:<hash>` agent identity;
it does not put the raw ID in tool arguments or persist it. The identity is used
for `start_work`, `update_work`, `transfer_work`, `finish_work`, and
`inspect_work`, so other harnesses can address this OpenCode session through
Concord.

## Message delivery

Concord's OpenCode integration supports pulling work and messages from the
durable inbox. OpenCode does not currently have a verified Concord wake or
resume receiver, so messages do not reach an idle session automatically. Run
`concord adapters status` to see this as `capabilities: pull` and
`monitor: none`.

The adapter commands inspect or manage the OpenCode entry for the repository
where they run:

```sh
concord adapters status
concord adapters doctor
concord adapters install
concord adapters uninstall
```

Uninstall removes only the Concord-owned MCP entry. Other servers, settings,
and comments remain in the OpenCode config.
