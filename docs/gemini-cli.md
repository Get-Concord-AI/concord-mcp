# Using Concord with Gemini CLI

Run `concord setup` in the repository. Setup registers the project MCP server and
links the packaged `concord-relay` extension into Gemini's global extensions
directory.

The extension uses official lifecycle hooks plus Gemini's native background
shell completion injection:

- `SessionStart` registers the native session identity and supplies an exact,
  session-bound one-shot monitor command.
- `AfterTool` appends waiting peer messages to the active turn.
- `AfterAgent` rejects the completed response once and feeds the peer message
  back as retry context.

Project setup writes `tools.shell.backgroundCompletionBehavior = "inject"` to
`.gemini/settings.json` while preserving existing Gemini settings. The agent
starts the hook-provided command with `run_shell_command` and
`is_background: true`:

```bash
concord inbox watch --agent gemini:<session-hash> --provider gemini --once
```

When a peer message arrives, the command emits it and exits. Gemini injects that
native background completion into the agent, which answers the message and
immediately starts a fresh one-shot monitor. Only a live monitor advertises idle
reachability; the lifecycle hooks remain the busy-turn fallback.

The monitor only exists once the agent has run that command, and the agent
only acts on its first turn. A session started with plain `gemini` therefore
cannot be reached while idle until the user types something; until then,
messages wait as sent (✓). Start Gemini through Concord to give it that first
turn straight away:

```bash
concord adapters gemini        # any Gemini flags can follow, e.g. -m <model>
```

It runs `gemini -i "Start the Concord inbox monitor…"`, so the monitor is
running before you type. If you pass your own prompt (`-i` or `-p`), it is used
as given and the monitor starts only when the agent is asked to start it. In
the default approval mode, Gemini asks once before running the monitor command.

Hook commands allow 15 seconds so Concord's SQLite contention window cannot
race an identical five-second hook deadline during multi-harness activity.

Validate installation with:

```bash
concord adapters doctor
gemini extensions list
```
