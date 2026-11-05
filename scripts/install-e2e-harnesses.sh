#!/usr/bin/env bash
# Install the pinned harness CLIs the real-harness e2e suite drives against a
# fake model (test/e2e/real). No accounts or API keys are needed: every
# harness is pointed at the local fake model by the suite itself.
#
# Every download is an exact version from an immutable URL and is checked
# against its SHA-256, so nothing changes between runs unless a pin does.
# Bump a version and its checksum here, run
# `CONCORD_E2E_REAL_HARNESSES=all pnpm e2e test/e2e/real`, and the suite says
# whether Concord still works with that release. Linux x86_64 (CI) only.
set -euo pipefail

CLAUDE_CODE_VERSION="2.1.305"
CODEX_VERSION="0.163.0"
COPILOT_VERSION="1.0.101"
GROK_VERSION="1.0.60"
GROK_SHA256="10e6af64b24724fc1074c373e906b9ad121110044dddcbd97ad43c3a25f96d5f"
GOOSE_VERSION="v1.54.0"
GOOSE_SHA256="bf01cb6359f7a2b1acb54ca4827e1d059b18aabb3d2b75202e21066cfd3a3396"
HERMES_VERSION="0.22.5"
HERMES_COMMIT="bf0203a794a07aac3ff764972ab9087baa4e4f4e"

if [[ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]]; then
  echo "install-e2e-harnesses.sh pins Linux x86_64 builds; install the CLIs yourself elsewhere." >&2
  exit 1
fi

BIN_DIR="${E2E_HARNESS_BIN:-${HOME}/.local/bin}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${BIN_DIR}"

fetch() {
  local url="$1" sha="$2" out="$3"
  curl -fsSL --retry 3 -o "${out}" "${url}"
  echo "${sha}  ${out}" | sha256sum --check --quiet
}

# npm versions are immutable once published.
npm install --global --no-audit --no-fund \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  "@openai/codex@${CODEX_VERSION}" \
  "@github/copilot@${COPILOT_VERSION}"

# The binaries Grok's and Goose's install scripts would download, fetched directly.
fetch "https://x.ai/cli/grok-${GROK_VERSION}-linux-x86_64" "${GROK_SHA256}" "${WORK}/grok"
install -m 0755 "${WORK}/grok" "${BIN_DIR}/grok"

fetch "https://github.com/block/goose/releases/download/${GOOSE_VERSION}/goose-x86_64-unknown-linux-gnu.tar.bz2" \
  "${GOOSE_SHA256}" "${WORK}/goose.tar.bz2"
tar -xjf "${WORK}/goose.tar.bz2" -C "${WORK}" ./goose
install -m 0755 "${WORK}/goose" "${BIN_DIR}/goose"

# Hermes is installed from an immutable upstream release commit, into the runner's
# disposable HOME. Its MCP config and gateway state are isolated per sandbox.
curl -fsSL --retry 3 -o "${WORK}/hermes-install.sh" \
  "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_COMMIT}/scripts/install.sh"
HERMES_HOME="${HOME}/.hermes"
HERMES_INSTALL_DIR="${HERMES_HOME}/hermes-agent"
bash "${WORK}/hermes-install.sh" \
  --commit "${HERMES_COMMIT}" --dir "${HERMES_INSTALL_DIR}" --hermes-home "${HERMES_HOME}" \
  --non-interactive --skip-browser --skip-computer-use
"${BIN_DIR}/hermes" --version | grep -F "${HERMES_VERSION}" >/dev/null

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "${BIN_DIR}" >> "${GITHUB_PATH}"
fi
