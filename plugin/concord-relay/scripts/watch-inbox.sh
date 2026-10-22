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
# The harness is whatever started this script: once it is gone, or this
# process has been reparented to someone else (init, or a subreaper such as
# systemd --user), stop. A harness that is itself pid 1 (a container) keeps
# working, because the parent never changes.
HARNESS_PID="${PPID}"
harness_alive() {
  local parent
  kill -0 "${HARNESS_PID}" 2>/dev/null || return 1
  parent="$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')"
  [ -z "${parent}" ] || [ "${parent}" = "${HARNESS_PID}" ]
}

# Identity needs no configuration: Claude Code exports CLAUDE_CODE_SESSION_ID
# into this process, and `concord inbox drain` derives the agent id from it.
# CONCORD_AGENT_ID overrides it when a human wants to name the agents.

# Once installed, this plugin loads in every session, most of which have nothing
# to do with Concord. Exit immediately rather than leaving a poll loop spawning
# a subprocess every couple of seconds for the life of an unrelated project.
if ! "${CONCORD_BIN}" inbox status >/dev/null 2>&1; then
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
