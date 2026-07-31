# Concord Whack-a-Mole

A three-pane live demo of two real coding-agent sessions and one shared
workspace, with an independent Claude Code review running in the background. The
app starts as a holding screen and becomes a playable Whack-a-Mole game while
the panes show the real Concord workflow.

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

The frontend and backend panes are actual Claude Code and Codex sessions. The
reviewer is also a real Claude Code session and runs only after both builders
have marked their work review-ready. The demo fails clearly if either provider
CLI is unavailable; it never substitutes scripted agent behavior.

All five public tools appear in the flow: `start_work`, `inspect_work`,
`update_work`, `transfer_work`, and `finish_work`. The model sessions make the
decisions and edits themselves; Concord supplies the shared state, overlap
detection, live prompt/reply relay, durable handoff, and review evidence.

Useful controls:

```bash
DEMO_PORT=3211 pnpm demo        # choose another port
pnpm demo:stop                  # stop tmux and the owned dev server
```
