# Using Concord with Grok Build

Run `concord setup` in the repository. Setup installs and trusts Concord's Grok
plugin when `grok` is detected. The plugin registers the session and drains
messages through PostToolUse and Stop hooks.

Grok also has a native persistent `monitor` tool: each line from a watched
command becomes a conversation notification and can wake a new turn. Concord's
generated AGENTS instructions tell Grok to start one persistent monitor for:

```bash
concord inbox watch --agent grok:<id> --provider grok
```

The plugin's SessionStart hook prints this command with the session's id filled
in. Keep `--agent`: Grok's `monitor` does not pass `GROK_SESSION_ID` to the
command, so Concord cannot otherwise tell which session is watching.

That is the preferred idle-delivery path. Grok's passive SessionStart hook cannot
invoke a model tool itself, so the agent starts the monitor once per session;
hooks remain the fallback until it does. Avoid duplicate monitors.

Check the result with `concord adapters doctor` and `grok plugin details
concord-relay`.
