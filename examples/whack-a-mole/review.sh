#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${DEMO_PORT:-3210}"
review_prompt="$(sed "s/\${DEMO_PORT}/$PORT/g" "$TOOL_DIR/review-prompt.md")"

claude \
  -p \
  --dangerously-skip-permissions \
  --mcp-config .mcp.json \
  --strict-mcp-config \
  --model haiku \
  --name "Concord Reviewer" \
  "$review_prompt" \
  < /dev/null 2>&1 | perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g'
