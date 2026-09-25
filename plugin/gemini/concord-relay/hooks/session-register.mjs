#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function concordExecutable() {
  const overide = process.env.CONCORD_EXECUTABLE?.trim();
  if (overide) return overide;
  return process.platform === 'win32' ? 'concord.cmd' : 'concord';
}

function sessionIdFrom(payload) {
  const parsed = JSON.parse(payload);
  const sessionId = parsed.session_id ?? parsed.sessionId;
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('Gemini SessionStart payload did not include a session id.');
  }
  return sessionId.trim();
}

function agentIdForSession(sessionId) {
  const suffix = createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
  return `gemini:${suffix}`;
}

function runConcord(args, options = {}) {
  return spawnSync(concordExecutable(), args, {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    encoding: 'utf8',
    input: options.input,
    shell: process.platform === 'win32',
  });
}

function register() {
  const payload = readFileSync(0, 'utf8');
  const sessionId = sessionIdFrom(payload);
  const agentId = agentIdForSession(sessionId);
  const result = runConcord(['inbox', 'register', '--from-hook', '--provider', 'gemini'], {
    input: payload,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const monitorCommand = `concord inbox watch --agent ${agentId} --provider gemini --once`;
  process.stdout.write(
    JSON.stringify({
      suppressOutput: true,
      systemMessage: `Concord registered this Gemini session as ${agentId}.`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          `Concord: this session is agent ${agentId}. Keep exactly one native background ` +
          `inbox monitor active. Run \`${monitorCommand}\` with run_shell_command and ` +
          `is_background: true. When its completion is injected, answer the peer message ` +
          `and immediately start a fresh monitor.`,
      },
    }),
  );
}

register();
