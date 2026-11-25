# OpenHands Agent Server

Give each OpenHands conversation its own Concord identity and inbox in a shared Git checkout. These steps use the local Linux Agent Server `1.63.0-python` and a POSIX shell.

## Install Concord on the Agent Server

From the Concord source checkout, build the npm package with Node.js 24 and pnpm 10. The image installs both the Python tool and the Concord server from that package.

```sh
pnpm install --frozen-lockfile
pnpm build
bundle=$(mktemp -d)
npm pack --pack-destination "$bundle"
mv "$bundle"/*.tgz "$bundle/concord.tgz"
docker build -t concord-openhands:local -f - "$bundle" <<'DOCKERFILE'
FROM ghcr.io/openhands/agent-server:1.63.0-python
COPY concord.tgz /tmp/concord.tgz
RUN mkdir -p /home/openhands/conversations && npm install --prefix /home/openhands/concord --no-fund --no-audit /tmp/concord.tgz
ENV PATH="/home/openhands/concord/node_modules/.bin:$PATH"
ENV OH_CONVERSATIONS_PATH=/home/openhands/conversations
CMD ["--extra-python-path", "/home/openhands/concord/node_modules/@concord-ai/concord-mcp/plugin/openhands", "--import-modules", "concord_openhands"]
DOCKERFILE
```

From the root of the **project you want to work on**, start the server. Its `openhands` user (UID 10001) needs write access to the checkout. The named volume keeps the conversation history when you replace the container.

```sh
export SESSION_API_KEY="$(openssl rand -hex 32)"
docker run -d --name concord-openhands -p 127.0.0.1:8000:8000 \
  -e SESSION_API_KEY --mount "type=bind,src=$PWD,dst=/repo" \
  --mount source=concord-oh-conversations,target=/home/openhands/conversations \
  concord-openhands:local
curl --retry 30 --retry-all-errors --retry-delay 1 -fsS http://127.0.0.1:8000/health
```

## Claim a task and check it from a peer

If you already create conversations through an OpenHands client, set `workspace.working_dir` to `/repo` and append `{"name":"concord"}` to `agent.tools`. Keep your model and existing tools. Remove any older `concord` entry from `agent.mcp_config` so the conversation loads one copy.

To try it from a shell, export `LLM_MODEL` (e.g. `openai/gpt-4o-mini`) and `LLM_API_KEY` for your provider. This example uses `jq` to create a conversation and give it a first task.

```sh
api=http://127.0.0.1:8000/api/conversations
auth="X-Session-API-Key: $SESSION_API_KEY"
conversation=$(jq -n '{workspace:{working_dir:"/repo"}, autotitle:false,
  agent:{kind:"Agent", llm:{model:env.LLM_MODEL, api_key:env.LLM_API_KEY},
         tools:[{name:"concord"}]}}' |
  curl -fsS -H "$auth" -H 'Content-Type: application/json' --data-binary @- "$api" | jq -er '.id')
curl -fsS -H "$auth" -H 'Content-Type: application/json' "$api/$conversation/events" \
  -d '{"role":"user","content":[{"type":"text","text":"Use start_work to claim parser-check with title Check parser behavior and kind openhands. Tell me your Concord agent ID."}],"run":true}'
```

The event starts a turn asynchronously. Run `curl -fsS -H "$auth" "$api/$conversation" | jq -r '.execution_status'` until it prints `finished`. Let this first claim initialize a fresh repository before starting peers concurrently. Then inspect it from a second shell.

```sh
docker exec -w /repo concord-openhands concord work inspect --task parser-check
```

The result should show `task.taskId` as `parser-check` and `task.agentId` as the same `openhands:…` ID. A Codex session connected to Concord in the same checkout can call `inspect_work` with `task_id: "parser-check"` to see that claim. This setup covers local peers sharing one `.concord` database. Separate cloud workspaces and independent clones each have their own state.

## Resume, fork and check messages

Save the conversation ID returned at creation. After restarting the server with the same volume and checkout, reattach to that ID (`GET /api/conversations/{id}`) to retain the owner and inbox. A native fork (`POST /api/conversations/{id}/fork`) inherits the earlier conversation history and gets its own Concord identity. The parent keeps its claims, and new messages addressed to the parent stay in its inbox.

The fork and peer-message integration test runs manually, outside CI. From the source checkout in the SDK 1.63 environment with the matching Concord CLI on `PATH`, run `PYTHONPATH=plugin/openhands python test/e2e/real/openhands_fork.py`.

Ask OpenHands to call `inspect_work` on its own inbox during a turn. An idle conversation waits for its next turn. Inspecting the inbox can mark a message as read. Showing the body and message ID to a model that reads only MCP text requires [the `inspect_work` text response change](https://github.com/Get-Concord-AI/concord-mcp/pull/408).
