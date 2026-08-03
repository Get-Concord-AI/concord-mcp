#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$TOOL_DIR/../.." && pwd)"
DEMO_DIR="${DEMO_DIR:-${TMPDIR:-/tmp}/concord-whack-demo}"
SESSION="${DEMO_SESSION:-concord-whack}"
PORT="${DEMO_PORT:-3210}"
INTRO_SECONDS="${DEMO_INTRO_SECONDS:-7}"
FE_TO_BE_GAP="${DEMO_FE_TO_BE_GAP:-3}"
CLAIM_TIMEOUT="${DEMO_CLAIM_TIMEOUT:-60}"
CLI="$ROOT_DIR/dist/cli/index.js"

case "$(basename "$DEMO_DIR")" in
  concord-whack-demo*) ;;
  *) echo "Refusing to reset unsafe DEMO_DIR: $DEMO_DIR" >&2; exit 1 ;;
esac
if [[ "$DEMO_DIR" == "/" || "$DEMO_DIR" == "$HOME" || "$DEMO_DIR" == "$ROOT_DIR" || "$DEMO_DIR" == "$TOOL_DIR" ]]; then
  echo "Refusing to reset protected path: $DEMO_DIR" >&2
  exit 1
fi

for command_name in node npm tmux curl git claude codex; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "Missing required command: $command_name" >&2; exit 1; }
done

if tmux has-session -t "$SESSION" 2>/dev/null; then tmux kill-session -t "$SESSION"; fi
if tmux has-session -t "$SESSION-server" 2>/dev/null; then tmux kill-session -t "$SESSION-server"; fi
if tmux has-session -t "$SESSION-reviewer" 2>/dev/null; then tmux kill-session -t "$SESSION-reviewer"; fi
if [[ -f "$DEMO_DIR/.demo-server.pid" ]]; then
  old_pid="$(tr -dc '0-9' < "$DEMO_DIR/.demo-server.pid")"
  [[ -n "$old_pid" ]] && kill "$old_pid" 2>/dev/null || true
fi
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Set DEMO_PORT to a free port." >&2
  exit 1
fi

mkdir -p "$DEMO_DIR"
find "$DEMO_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} +
cp -R "$TOOL_DIR/fixture/." "$DEMO_DIR/"
mv "$DEMO_DIR/gitignore" "$DEMO_DIR/.gitignore"
git -C "$DEMO_DIR" init -q
git -C "$DEMO_DIR" config user.name "Concord Demo"
git -C "$DEMO_DIR" config user.email "demo@getconcord.ai"
git -C "$DEMO_DIR" add .
git -C "$DEMO_DIR" commit -qm "Initial holding screen"

# Register the actual MCP server and live-provider integrations. No simulated
# agent path or reviewer fallback exists in this mode.
CONCORD_NO_UPDATE_CHECK=1 node "$CLI" --repo "$DEMO_DIR" setup --agent-comms >/dev/null
if [[ ! -x "$DEMO_DIR/node_modules/.bin/next" ]]; then
  echo "Installing the demo app once (the cache is reused on later runs)…"
  npm --prefix "$DEMO_DIR" install --no-audit --no-fund
fi

# The disposable repo is created by this script, so pre-authorize it for Codex
# and automatically accept Claude's one-time interactive trust screen below.
# This avoids leaving the real model session paused before its first MCP call.
CODEX_CONFIG_PATH="${CODEX_HOME:-$HOME/.codex}/config.toml"
if ! grep -qF "[projects.\"$DEMO_DIR\"]" "$CODEX_CONFIG_PATH" 2>/dev/null; then
  mkdir -p "$(dirname "$CODEX_CONFIG_PATH")"
  printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$DEMO_DIR" >> "$CODEX_CONFIG_PATH"
fi

tmux new-session -d -s "$SESSION-server" -n next -c "$DEMO_DIR" \
  "npm run dev -- --port '$PORT' > .demo-server.log 2>&1"
ready=0
for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:$PORT" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.25
done
[[ "$ready" == "1" ]] || { echo "Next.js did not become ready. Log: $DEMO_DIR/.demo-server.log" >&2; exit 1; }
if [[ "${DEMO_NO_OPEN:-0}" != "1" ]] && command -v open >/dev/null 2>&1; then open "http://127.0.0.1:$PORT"; fi

# Visible layout: real Claude and Codex sessions on the left, full-height
# Concord dashboard on the right. The reviewer is a real hidden Claude session.
tmux new-session -d -x "${DEMO_TMUX_WIDTH:-180}" -y "${DEMO_TMUX_HEIGHT:-48}" -s "$SESSION" -n live -c "$DEMO_DIR"
FE_PANE="$(tmux display-message -p -t "$SESSION:live.0" '#{pane_id}')"
DASH_PANE="$(tmux split-window -h -l '50%' -P -F '#{pane_id}' -t "$FE_PANE" -c "$DEMO_DIR")"
BE_PANE="$(tmux split-window -v -P -F '#{pane_id}' -t "$FE_PANE" -c "$DEMO_DIR")"
tmux set-option -t "$SESSION" pane-border-status top
tmux set-option -t "$SESSION" pane-border-format ' #[bold]#{pane_title}#[default] '
tmux set-option -t "$SESSION" status-style 'bg=#151a30,fg=#f8f6ef'
tmux set-option -t "$SESSION" status-left ' CONCORD · LIVE '
tmux set-option -t "$SESSION" status-right " http://127.0.0.1:$PORT "
tmux set-option -t "$SESSION" remain-on-exit on
tmux select-pane -t "$FE_PANE" -T 'CLAUDE · FRONTEND'
tmux select-pane -t "$BE_PANE" -T 'CODEX · BACKEND'
tmux select-pane -t "$DASH_PANE" -T 'CONCORD · SHARED WORKSPACE'
tmux send-keys -t "$FE_PANE" "clear; printf '\\n  CLAUDE CODE · REAL SESSION\\n  Waiting for the demo to begin…\\n'" C-m
tmux send-keys -t "$BE_PANE" "clear; printf '\\n  CODEX · REAL SESSION\\n  Waiting for Claude to claim work…\\n'" C-m
tmux send-keys -t "$DASH_PANE" "CONCORD_NO_UPDATE_CHECK=1 node '$CLI' --repo '$DEMO_DIR' dashboard" C-m

send_line() {
  local pane="$1" line="$2"
  tmux send-keys -t "$pane" C-u
  tmux send-keys -t "$pane" -l "$line"
  tmux send-keys -t "$pane" Enter
}
accept_claude_trust() {
  local pane="$1"
  for _ in $(seq 1 80); do
    if tmux capture-pane -p -t "$pane" -S -30 2>/dev/null | grep -q 'Yes, I trust this folder'; then
      tmux send-keys -t "$pane" 1 Enter
      return 0
    fi
    sleep 0.25
  done
  return 1
}
wait_for_task() {
  local task="$1" timeout="${2:-$CLAIM_TIMEOUT}" waited=0
  while (( waited < timeout )); do
    if (cd "$DEMO_DIR" && CONCORD_NO_UPDATE_CHECK=1 node "$CLI" tasks 2>/dev/null | grep -q "^${task}"); then return 0; fi
    sleep 1; waited=$((waited + 1))
  done
  return 1
}

(
  sleep "$INTRO_SECONDS"
  send_line "$FE_PANE" "claude --dangerously-skip-permissions --mcp-config .mcp.json --strict-mcp-config --name 'Concord Frontend' \"\$(cat '$TOOL_DIR/prompts/frontend.md')\""
  accept_claude_trust "$FE_PANE" || true
  wait_for_task TASK-FE || true
  sleep "$FE_TO_BE_GAP"
  send_line "$BE_PANE" "codex --dangerously-bypass-approvals-and-sandbox \"\$(cat '$TOOL_DIR/prompts/backend.md')\""

  # Do not interrupt either model. Once both have genuinely marked work
  # review-ready, start the independent real Claude reviewer in the background.
  for _ in $(seq 1 1200); do
    tasks="$(cd "$DEMO_DIR" && CONCORD_NO_UPDATE_CHECK=1 node "$CLI" tasks 2>/dev/null || true)"
    if grep -q '^TASK-FE.*review_ready' <<<"$tasks" && grep -q '^TASK-BE.*review_ready' <<<"$tasks"; then
      tmux new-session -d -s "$SESSION-reviewer" -n review -c "$DEMO_DIR" \
        "DEMO_PORT='$PORT' bash '$TOOL_DIR/review.sh' > .concord/reviewer.log 2>&1"
      break
    fi
    sleep 1
  done
) &

echo
echo "Concord Whack-a-Mole is live with real model sessions"
echo "  tmux: $SESSION"
echo "  app:  http://127.0.0.1:$PORT"
echo "  repo: $DEMO_DIR"
echo

if [[ "${DEMO_NO_ATTACH:-0}" == "1" ]]; then
  wait
else
  exec tmux attach-session -t "$SESSION"
fi
