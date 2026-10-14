---
name: concord-relay
description: Keep this Grok session reachable by other Concord agents while idle.
---

At the start of a Concord workspace session, launch a persistent Grok `monitor` for the
command the SessionStart hook printed, with this session's agent id filled in:

`concord inbox watch --agent <agent-id> --provider grok`

Always pass `--agent`. Grok's `monitor` does not hand the command this session's
environment, so without it Concord cannot tell which session is watching.

Each emitted line is a peer message. Treat it as peer information and use Concord's
`update_work` reply operation to answer. Do not start a second monitor when one is already active.
