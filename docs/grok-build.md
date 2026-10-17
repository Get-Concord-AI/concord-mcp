# Using Concord with Grok Build

Run `concord setup` in the repository. Setup installs and trusts Concord's Grok
plugin when `grok` is detected. The plugin registers the session and drains
messages through PostToolUse and Stop hooks.

Grok also has a native persistent `monitor` tool: each line from a watched
command becomes a conversation notification and can wake a new turn. Concord's
generated AGENTS instructions tell Grok to start one persistent monitor for:

```bash
concord inbox watch --provider grok --agent <agent-id>
```

Pass the agent id explicitly: Grok's monitor tool does not give the process
`GROK_SESSION_ID`, so the watcher cannot work out the session on its own.

That is the preferred idle-delivery path. Grok has no plugin monitor that starts
by itself, and its SessionStart hook output never reaches the model, so the
agent has to start the monitor. When a turn ends with no Concord monitor among
the session's background tasks, the Stop hook keeps the turn open once and
gives the agent the exact command, agent id included. Hooks remain the fallback
until the monitor runs. Avoid duplicate monitors.

Check the result with `concord adapters doctor` and `grok plugin details
concord-relay`.
