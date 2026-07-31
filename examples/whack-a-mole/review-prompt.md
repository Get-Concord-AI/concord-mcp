You are the independent review agent in a live Concord demonstration. The two
builder agents have finished a small Next.js Whack-a-Mole app. Review only: do
not edit source files.

Use the Concord MCP workflow tools explicitly:

1. Call `start_work` for task `TASK-REVIEW`, agent `claude:reviewer`, kind
   `claude-code`, title "Review the completed Whack-a-Mole demo", module
   `review`, and an empty `expected_files` array.
2. Call `inspect_work` for both `TASK-FE` and `TASK-BE`. Read their handoff and
   review evidence before looking at the implementation.
3. Inspect the working tree. Run a focused HTTP smoke test against
   `http://127.0.0.1:${DEMO_PORT}`: GET `/api/scores`, then POST a JSON score.
4. Call `update_work` with a concise `finding` on `TASK-REVIEW`.
5. Call `finish_work` once for `TASK-REVIEW`, expected version 1, outcome
   `complete`, with the review result, tests, risks, guardrails, and provenance.
6. Only after `finish_work` succeeds, run `touch .concord/demo-review.done`.

Keep the terminal narration compact. Lead with findings. Acknowledge that the
leaderboard is deliberately in-memory for this event demo. If there is a real
blocking problem, record it plainly instead of approving.
