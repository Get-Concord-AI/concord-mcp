# Concord Whack-a-Mole

A three-pane live demo of two real coding-agent sessions and one shared
workspace, with an independent Claude Code review running in the background. The
app starts as a holding screen and becomes a playable Whack-a-Mole game while
the panes show the real Concord workflow.

```bash
pnpm demo
```

That command builds Concord, prepares a disposable repository at
`/tmp/concord-whack-demo`, starts Next.js and a tmux session, opens the browser
when the host provides `open`, and starts the story. The app is at
<http://127.0.0.1:3210>.

The demo requires authenticated `claude` and `codex` CLIs plus `tmux`. Because
the builders are real model sessions, the run is intentionally nondeterministic
and may take several minutes; it is not a fixed-duration simulation.

When the agents follow the supplied prompts, the visible panes show:

1. Claude claiming and building the game UI while remaining promptable.
2. Codex claiming an overlapping scope, seeing the collision before editing,
   prompting busy Claude live, building the API, and offering a handoff.
3. The Concord dashboard updating from the shared SQLite workspace. After both
   builders reach `review_ready`, an independent reviewer runs in a hidden
   session and its task activity appears in the dashboard.

The frontend and backend panes are actual Claude Code and Codex sessions. The
reviewer is also a real Claude Code session and runs only after both builders
have marked their work review-ready. The demo fails clearly if either provider
CLI is unavailable; it never substitutes scripted agent behavior.

The prompts ask the builders to use all five public tools—`start_work`,
`inspect_work`, `update_work`, `transfer_work`, and `finish_work`. The dashboard
shows the calls the models actually make. The model sessions make the decisions
and edits themselves; Concord supplies the shared state, overlap detection,
live prompt/reply relay, durable handoff, and review evidence.

Useful controls:

```bash
DEMO_PORT=3211 pnpm demo        # choose another port
pnpm demo:stop                  # stop tmux and the owned dev server
```
