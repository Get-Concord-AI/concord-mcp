# Cross-harness end-to-end suite

```bash
pnpm e2e                          # build, pack, install, run (about a minute)
CONCORD_E2E_SKIP_BUILD=1 pnpm e2e # reuse dist/
CONCORD_E2E_KEEP=1 pnpm e2e       # keep sandboxes in .e2e/sandboxes for inspection
```

The suite tests Concord as a user installs it. `global-setup.ts` runs
`npm pack` (as releases use `npm publish`) and installs the tarball into
`.e2e/prefix`. Each test file then gets a `Sandbox`: its own `HOME`, a fresh
git repository, and that install on `PATH`. `concord setup` runs for real.

The harness binaries `setup` and the Codex host shell out to (`claude`,
`codex`, `cursor`, `grok`, `goose`, `agy`, `copilot`) are played by
`shims/harness-shim.mjs`. It reports the verified minimum version, records
every call, and acts as a Codex app-server so `turn/start` and `turn/steer` can
be observed.

`CONCORD_E2E_ROOT` moves `.e2e/`. It must not be under a temp directory,
because Concord treats adapter links into one as throwaway checkouts.

## Real harnesses against a fake model (`test/e2e/real`)

Claude Code, Codex, Copilot CLI, Grok and Goose let you choose the model API they
call. The
real-harness suite runs their **real binaries** against a local fake model
(`real/fake-model`) that speaks the Anthropic Messages and OpenAI Responses
APIs. A scripted brain plays a cooperative agent: it loads Concord's tools,
calls `start_work`, and answers every `[concord from … id=…]` message with
`update_work`. Each harness really loads Concord's adapter, runs its hooks and
monitors, and takes turns. Only the model is replaced, so runs are
deterministic and need no accounts.

| Harness     | Mid-turn                                   | Idle                                              |
| ----------- | ------------------------------------------ | ------------------------------------------------- |
| Claude Code | PostToolUse hook                           | plugin monitor in a real TUI                      |
| Codex       | hooks (pre-trusted)                        | `concord adapters codex` controller starts a turn |
| Copilot CLI | postToolUse hook                           | `concord adapters copilot` host starts a turn     |
| Grok        | PostToolUse hook                           | persistent `monitor` the model starts when asked  |
| Goose       | sends; messages to it are refused honestly | —                                                 |

### Receipts

Every receipt scenario checks sent → delivered → read → replied from the
sender's side (`Probe.receipt`, `inspect_work message_id`) and appends a row to
`.e2e/receipt-report.jsonl`, written before the scenario asserts, so a run ends
with a table of exactly what each harness did. A message whose body starts with
`SILENT-` is read but never answered by the fake brain, so a read tick can only
come from read evidence, never from a reply. Claude Code also covers a message
held behind `AskUserQuestion` (answered, and dismissed with Esc), a crash while
holding one (✓✓ falls back to ✓, then a fresh session takes it back), and one
agent being kept out of another's mail. `codex-adapter.e2e.test.ts` pins the
Codex adapter's own read path (`clientUserMessageId` + completed turn) against a
real `codex app-server`.

Bytes written to `<log>.keys` are typed into a pseudo-terminal session
(`HarnessRun.type`), and `HarnessRun.untilScreen` waits for text on its screen.

Interactive sessions run in a pseudo-terminal (`real/pty-run.py`, Python 3).
A harness that is not installed is skipped. `CONCORD_E2E_REAL_HARNESSES=all`
(or a comma list) makes them required, which CI does after
`scripts/install-e2e-harnesses.sh` installs pinned versions.

Run it as a normal user: Claude Code refuses its permission-bypass options as
root, which is the usual default in a Docker container.

Copilot CLI runs offline with a custom provider (`COPILOT_OFFLINE`,
`COPILOT_PROVIDER_*`), so it needs no GitHub login either.

Cursor and Antigravity talk to private vendor backends, so they cannot be
pointed at a fake model; they are covered by the simulated drivers below.

## Drivers

For Cursor and Antigravity, and as fast checks of setup and identity, a
simulated driver (`drivers/<harness>.ts`) plays one session of a harness:

- it reads every hook and MCP command from the files `setup` installed, never
  from a hardcoded string;
- it sends that harness's hook payloads and environment (Codex: session id on
  stdin only, scrubbed MCP env; Cursor: `conversation_id`, `workspace_roots`;
  Copilot: `sessionId` in hooks, `COPILOT_AGENT_SESSION_ID` for MCP);
- it parses that harness's output envelopes back into delivered messages.

The scenarios (`delivery.e2e.test.ts`) run every sender × receiver × state over
the registered drivers. They check that the sender was told the truth about
delivery, that the message arrived through the promised channel exactly once,
and that the reply threads back.

## Adding a harness

1. Write `drivers/<harness>.ts` extending `HarnessSession`.
2. Register it in `drivers/index.ts`; it drops out of the `UNDRIVEN` todo list.
3. Add its rows to `EXPECTED` in `delivery.e2e.test.ts`: the delivery outlook
   and immediate mode its catalog entry in `src/domain/harness-config.ts`
   promises for busy and idle receivers.
4. Add a shim version in `shims/harness-shim.mjs` if `setup` probes a new
   binary.

The plan, including the live tier against real harnesses, is tracked in #263.
