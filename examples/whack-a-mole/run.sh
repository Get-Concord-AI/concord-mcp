#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$TOOL_DIR/../.." && pwd)"
DEMO_DIR="${DEMO_DIR:-${TMPDIR:-/tmp}/concord-whack-demo}"
SESSION="${DEMO_SESSION:-concord-whack}"
PORT="${DEMO_PORT:-3210}"
SPEED="${DEMO_SPEED:-1}"
INTRO_SECONDS="${DEMO_INTRO_SECONDS:-3}"
GAP_SECONDS="${DEMO_GAP_SECONDS:-2}"
REVIEWER="${DEMO_REVIEWER:-claude}"
CLI="$ROOT_DIR/dist/cli/index.js"

case "$(basename "$DEMO_DIR")" in
  concord-whack-demo*) ;;
  *)
    echo "Refusing to reset an unsafe DEMO_DIR: $DEMO_DIR" >&2
    echo "Its basename must start with concord-whack-demo." >&2
    exit 1
    ;;
esac

if [[ "$DEMO_DIR" == "/" || "$DEMO_DIR" == "$HOME" || "$DEMO_DIR" == "$ROOT_DIR" || "$DEMO_DIR" == "$TOOL_DIR" ]]; then
  echo "Refusing to reset protected path: $DEMO_DIR" >&2
  exit 1
fi

for command_name in node npm tmux curl git; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

if [[ "$REVIEWER" == "claude" ]] && ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code is not installed; falling back to the deterministic reviewer." >&2
  REVIEWER="scripted"
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
fi
if tmux has-session -t "$SESSION-server" 2>/dev/null; then
  tmux kill-session -t "$SESSION-server"
fi

if [[ -f "$DEMO_DIR/.demo-server.pid" ]]; then
  old_pid="$(tr -dc '0-9' < "$DEMO_DIR/.demo-server.pid")"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" 2>/dev/null || true
  fi
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

CONCORD_NO_UPDATE_CHECK=1 node "$CLI" --repo "$DEMO_DIR" setup --no-mcp --agent-comms >/dev/null

if [[ ! -x "$DEMO_DIR/node_modules/.bin/next" ]]; then
  echo "Installing the demo app once (the cache is reused on later runs)…"
  npm --prefix "$DEMO_DIR" install --no-audit --no-fund
fi
mkdir -p "$DEMO_DIR/node_modules/.bin"
ln -sfn "$ROOT_DIR/dist" "$DEMO_DIR/node_modules/.concord-mcp"

tmux new-session -d -s "$SESSION-server" -n next -c "$DEMO_DIR" \
  "npm run dev -- --port '$PORT' > .demo-server.log 2>&1"

ready=0
for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done
if [[ "$ready" != "1" ]]; then
  echo "Next.js did not become ready. Log: $DEMO_DIR/.demo-server.log" >&2
  exit 1
fi

if [[ "${DEMO_NO_OPEN:-0}" != "1" ]] && command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT"
fi

tmux new-session -d -x "${DEMO_TMUX_WIDTH:-180}" -y "${DEMO_TMUX_HEIGHT:-48}" -s "$SESSION" -n live -c "$DEMO_DIR"
tmux split-window -v -t "$SESSION:live.0" -p 50 -c "$DEMO_DIR"
tmux split-window -h -t "$SESSION:live.0" -p 50 -c "$DEMO_DIR"
tmux split-window -v -t "$SESSION:live.2" -p 50 -c "$DEMO_DIR"
tmux select-layout -t "$SESSION:live" tiled
tmux set-option -t "$SESSION" pane-border-status top
tmux set-option -t "$SESSION" pane-border-format ' #[bold]#{pane_title}#[default] '
tmux set-option -t "$SESSION" status-style 'bg=#151a30,fg=#f8f6ef'
tmux set-option -t "$SESSION" status-left ' CONCORD · LIVE '
tmux set-option -t "$SESSION" status-right " http://127.0.0.1:$PORT "
tmux set-option -t "$SESSION" remain-on-exit on

tmux select-pane -t "$SESSION:live.0" -T 'CLAUDE · FRONTEND'
tmux select-pane -t "$SESSION:live.1" -T 'CODEX · BACKEND'
tmux select-pane -t "$SESSION:live.2" -T 'CONCORD · SHARED WORKSPACE'
tmux select-pane -t "$SESSION:live.3" -T 'CLAUDE CODE · REVIEWER'

tmux send-keys -t "$SESSION:live.0" "clear; printf '\\n  CLAUDE IS READY TO BUILD THE GAME UI\\n  Waiting for the demo to begin…\\n'" C-m
tmux send-keys -t "$SESSION:live.1" "clear; printf '\\n  CODEX IS READY TO BUILD THE SCORE API\\n  Waiting for Claude to claim work…\\n'" C-m
tmux send-keys -t "$SESSION:live.2" "CONCORD_NO_UPDATE_CHECK=1 node '$CLI' --repo '$DEMO_DIR' dashboard" C-m
tmux send-keys -t "$SESSION:live.3" "clear; printf '\\n  CLAUDE CODE REVIEWER\\n  Waiting for both review packets…\\n'" C-m

(
  sleep "$INTRO_SECONDS"
  tmux send-keys -t "$SESSION:live.0" "clear; CONCORD_SOURCE_ROOT='$ROOT_DIR' DEMO_SPEED='$SPEED' DEMO_PORT='$PORT' node '$TOOL_DIR/agent.mjs' fe" C-m
  sleep "$GAP_SECONDS"
  for _ in $(seq 1 120); do
    if [[ -S "$DEMO_DIR/.concord/fe.sock" ]]; then
      break
    fi
    sleep 0.1
  done
  tmux send-keys -t "$SESSION:live.1" "clear; CONCORD_SOURCE_ROOT='$ROOT_DIR' DEMO_SPEED='$SPEED' DEMO_PORT='$PORT' node '$TOOL_DIR/agent.mjs' be" C-m

  for _ in $(seq 1 360); do
    if [[ -f "$DEMO_DIR/.concord/demo-fe.done" && -f "$DEMO_DIR/.concord/demo-be.done" ]]; then
      break
    fi
    sleep 0.25
  done

  if [[ "$REVIEWER" == "claude" ]]; then
    tmux send-keys -t "$SESSION:live.3" "clear; CONCORD_REPO_ROOT='$DEMO_DIR' DEMO_PORT='$PORT' bash '$TOOL_DIR/review.sh'" C-m
  else
    tmux send-keys -t "$SESSION:live.3" "clear; CONCORD_SOURCE_ROOT='$ROOT_DIR' DEMO_SPEED='$SPEED' DEMO_PORT='$PORT' node '$TOOL_DIR/agent.mjs' review" C-m
  fi

  for review_tick in $(seq 1 600); do
    if [[ -f "$DEMO_DIR/.concord/demo-review.done" ]]; then
      sleep 1
      tmux send-keys -t "$SESSION:live.2" C-c
      sleep 0.5
      tmux send-keys -t "$SESSION:live.2" "clear; CONCORD_NO_UPDATE_CHECK=1 node '$CLI' --repo '$DEMO_DIR' status; printf '\\n'; CONCORD_NO_UPDATE_CHECK=1 node '$CLI' --repo '$DEMO_DIR' doctor; printf '\\n  ✓ GAME BUILT · HANDOFF ACCEPTED · REVIEW APPROVED\\n  Open http://127.0.0.1:$PORT and whack a mole.\\n'" C-m
      break
    fi
    if [[ "$REVIEWER" == "claude" && "$review_tick" == "240" ]]; then
      tmux send-keys -t "$SESSION:live.3" C-c
      sleep 0.5
      tmux send-keys -t "$SESSION:live.3" "clear; printf '\\n  Claude Code exceeded 60s — continuing with the local reviewer.\\n\\n'; CONCORD_SOURCE_ROOT='$ROOT_DIR' DEMO_SPEED='$SPEED' DEMO_PORT='$PORT' node '$TOOL_DIR/agent.mjs' review" C-m
    fi
    sleep 0.25
  done
) &

echo
echo "Concord Whack-a-Mole is live"
echo "  tmux:   $SESSION"
echo "  app:    http://127.0.0.1:$PORT"
echo "  repo:   $DEMO_DIR"
echo "  review: $REVIEWER"
echo

if [[ "${DEMO_NO_ATTACH:-0}" == "1" ]]; then
  for _ in $(seq 1 700); do
    if [[ -f "$DEMO_DIR/.concord/demo-review.done" ]]; then
      sleep 2
      for pane in 0 1 2 3; do
        echo "===== pane $pane ====="
        tmux capture-pane -p -t "$SESSION:live.$pane" -S -80
      done
      exit 0
    fi
    sleep 0.25
  done
  echo "Demo timed out. Inspect tmux session: $SESSION" >&2
  exit 1
fi

exec tmux attach-session -t "$SESSION"
