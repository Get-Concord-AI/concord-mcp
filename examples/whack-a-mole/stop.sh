#!/usr/bin/env bash
set -euo pipefail

DEMO_DIR="${DEMO_DIR:-${TMPDIR:-/tmp}/concord-whack-demo}"
SESSION="${DEMO_SESSION:-concord-whack}"

case "$(basename "$DEMO_DIR")" in
  concord-whack-demo*) ;;
  *)
    echo "Refusing unsafe DEMO_DIR: $DEMO_DIR" >&2
    exit 1
    ;;
esac

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
fi
if tmux has-session -t "$SESSION-server" 2>/dev/null; then
  tmux kill-session -t "$SESSION-server"
fi

if [[ -f "$DEMO_DIR/.demo-server.pid" ]]; then
  server_pid="$(tr -dc '0-9' < "$DEMO_DIR/.demo-server.pid")"
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid"
  fi
fi

echo "Stopped tmux session $SESSION and its demo server."
