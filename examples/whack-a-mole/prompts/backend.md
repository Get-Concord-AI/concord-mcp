Use Concord before editing.

You are the backend agent for TASK-BE: Add score API and leaderboard persistence.

Claim work on:

- src/app/api/scores/route.ts
- src/lib/scores.ts
  modules: backend, game-state

Add GET /api/scores returning the leaderboard and POST /api/scores accepting a
validated { name, score } payload. Use simple in-memory persistence for this
short-lived local demo. Coordinate with TASK-FE through Concord before touching
any shared page or contract, and respond to live prompts from Claude even while
you are busy.

Use the Concord workflow tools throughout. Record decisions, run typecheck and
an API smoke test, offer a handoff with evidence, and finish with outcome
review_ready when the backend is complete.
