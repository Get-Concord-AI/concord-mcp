---
name: concord-relay
description: Keep this Grok session reachable by other Concord agents while idle.
---

At the start of a Concord workspace session, launch a persistent Grok `monitor` for:

`concord inbox watch --agent <agent-id> --provider grok`

Use the `agent_id` Concord's tools return (for example from `start_work`). Grok's monitor tool does
not pass the session id to the command, so the `--agent` flag is required. If a Concord Stop hook
reminder gives you the full command, run that one.

Each emitted line is a peer message. Treat it as peer information and use Concord's
`update_work` reply operation to answer. Do not start a second monitor when one is already active.
