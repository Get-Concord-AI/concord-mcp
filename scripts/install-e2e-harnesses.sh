#!/usr/bin/env bash
# Install the pinned harness CLIs the real-harness e2e suite drives against a
# fake model (test/e2e/real). No accounts or API keys are needed: every
# harness is pointed at the local fake model by the suite itself.
#
# Bump a version here, run `CONCORD_E2E_REAL_HARNESSES=all pnpm e2e`, and the
# suite says whether Concord still works with that release.
set -euo pipefail

CLAUDE_CODE_VERSION="2.1.305"
CODEX_VERSION="0.163.0"
GROK_VERSION="1.0.60"
GOOSE_VERSION="v1.54.0"

npm install --global --no-audit --no-fund \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  "@openai/codex@${CODEX_VERSION}"

curl -fsSL https://x.ai/cli/install.sh | bash -s "${GROK_VERSION}"

curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh \
  | CONFIGURE=false GOOSE_VERSION="${GOOSE_VERSION}" bash

# The Grok and Goose installers put their binaries here.
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "${HOME}/.grok/bin" >> "${GITHUB_PATH}"
  echo "${HOME}/.local/bin" >> "${GITHUB_PATH}"
fi
