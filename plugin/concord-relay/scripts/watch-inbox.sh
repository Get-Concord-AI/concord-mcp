#!/usr/bin/env bash
# Concord relay monitor.
#
# Runs for the lifetime of an interactive session. Every line it prints becomes
# a notification in that session, which is the only channel that reaches an
# agent sitting idle at the prompt — hooks fire only when the agent is already
# doing something. `concord inbox drain` prints nothing on an empty inbox, so a
# quiet workspace stays quiet.
set -uo pipefail

CONCORD_BIN="${CONCORD_BIN:-concord}"
CONCORD_INBOX_POLL_SECONDS="${CONCORD_INBOX_POLL_SECONDS:-2}"

# A monitor orphaned by a crashed or killed harness would keep draining
# messages into a pipe nobody reads, marking them delivered to a dead session.
# The harness is whatever started this script. Claude Code starts monitors
# through a shell wrapper (`zsh -c … eval`), which can outlive a crashed
# harness, so look through any shell parents to the process that launched
# them. Once that process is gone, stop. A harness that is itself pid 1 (a
# container) keeps working.
harness_pid() {
  local pid="${PPID}" comm
  for _ in 1 2 3; do
    comm="$(ps -o comm= -p "${pid}" 2>/dev/null | sed 's#.*/##; s#^-##')"
    case "${comm}" in
      sh | bash | zsh | dash | fish) pid="$(ps -o ppid= -p "${pid}" 2>/dev/null | tr -d ' ')" ;;
      *) break ;;
    esac
  done
  printf '%s' "${pid}"
}
HARNESS_PID="$(harness_pid)"
harness_alive() {
  [ -z "${HARNESS_PID}" ] || [ "${HARNESS_PID}" = "0" ] || kill -0 "${HARNESS_PID}" 2>/dev/null
}

# Identity needs no configuration: Claude Code exports CLAUDE_CODE_SESSION_ID
# into this process, and `concord inbox drain` derives the agent id from it.
# CONCORD_AGENT_ID overrides it when a human wants to name the agents.

# Once installed, this plugin loads in every session, most of which have nothing
# to do with Concord. Exit rather than leaving a poll loop spawning a subprocess
# every couple of seconds for the life of an unrelated project.
#
# A single failed check is not proof, though: a resumed session can start while
# the previous process is still shutting down, and one transient failure here
# used to kill the monitor for the rest of the session without a word (#180).
# So retry a few times with a short backoff before deciding this directory is
# not a Concord workspace. An unrelated project pays a few extra seconds once,
# at session start.
CONCORD_INBOX_STARTUP_ATTEMPTS="${CONCORD_INBOX_STARTUP_ATTEMPTS:-3}"
CONCORD_INBOX_STARTUP_BACKOFF_SECONDS="${CONCORD_INBOX_STARTUP_BACKOFF_SECONDS:-1}"
workspace_ready() {
  local attempt=1 delay="${CONCORD_INBOX_STARTUP_BACKOFF_SECONDS}"
  while true; do
    "${CONCORD_BIN}" inbox status >/dev/null 2>&1 && return 0
    [ "${attempt}" -ge "${CONCORD_INBOX_STARTUP_ATTEMPTS}" ] && return 1
    harness_alive || return 1
    sleep "${delay}"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}
if ! workspace_ready; then
  exit 0
fi

# Linked to Concord Cloud: one long-lived receiver long-polls the cloud, so a
# message arrives within moments and the monitor costs one request per round,
# not a new process every couple of seconds. Restarted after any failure it
# cannot ride out itself (a lapsed login, say), slowly.
if "${CONCORD_BIN}" inbox status --cloud >/dev/null 2>&1; then
  while harness_alive; do
    "${CONCORD_BIN}" inbox watch --provider claude-code --format monitor 2>/dev/null || true
    sleep 30
  done
fi

while true; do
  # Never let a transient failure (a locked database, a mid-write config) kill
  # the monitor: a dead monitor silently stops delivering messages.
  # A drained message counts as delivered, never read: Claude Code may hold the
  # notification while the agent is blocked on its user. Read is recorded by
  # this plugin's hooks once the message id shows up in the session's prompt
  # or transcript.
  harness_alive || exit 0
  "${CONCORD_BIN}" inbox drain --format monitor 2>/dev/null || true
  sleep "${CONCORD_INBOX_POLL_SECONDS}"
done
