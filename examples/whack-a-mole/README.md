# Concord Whack-a-Mole

A three-pane live demo of two coding agents and one shared workspace, with an
independent Claude Code review running in the background. The app starts as a
holding screen and becomes a playable Whack-a-Mole game while the panes show the
real Concord workflow.

```bash
pnpm demo
```

That command builds Concord, prepares a disposable repository at
`/tmp/concord-whack-demo`, starts Next.js and a tmux session, opens the browser,
and runs the story. The app is at <http://127.0.0.1:3210>.

The visible panes show:

1. Claude claiming and building the game UI while remaining promptable.
2. Codex claiming an overlapping scope, seeing the collision before editing,
   prompting busy Claude live, building the API, and offering a handoff.
3. The Concord dashboard updating from the shared SQLite workspace and showing
   the reviewer’s task activity. The reviewer itself runs in a hidden session so
   the dashboard gets the full right half of the screen.

If Claude Code is unavailable or takes longer than 60 seconds, the reviewer
pane automatically continues with the same deterministic MCP review so the
live demo never stalls.

All five public tools appear in the flow: `start_work`, `inspect_work`,
`update_work`, `transfer_work`, and `finish_work`. The builders are scripted for
repeatability, but their MCP calls, live prompt/reply relay, task versions,
handoff, generated evidence, file edits, hot reload, and reviewer are real.

For an offline or automated rehearsal, swap only the reviewer for the
deterministic version:

```bash
DEMO_REVIEWER=scripted DEMO_NO_OPEN=1 pnpm demo
```

Useful controls:

```bash
DEMO_SPEED=0.25 pnpm demo       # faster narration
DEMO_PORT=3211 pnpm demo        # choose another port
pnpm demo:stop                  # stop tmux and the owned dev server
```
