#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readPayload() {
  const input = readFileSync(0, 'utf8').trim();
  return input === '' ? {} : JSON.parse(input);
}

function projectRoot(payload) {
  const configured = process.env.CURSOR_PROJECT_DIR?.trim();
  if (configured) return configured;
  if (Array.isArray(payload.workspace_roots) && typeof payload.workspace_roots[0] === 'string') {
    return payload.workspace_roots[0];
  }
  return process.cwd();
}

function sessionId(payload) {
  if (typeof payload.session_id === 'string' && payload.session_id !== '')
    return payload.session_id;
  if (typeof payload.conversation_id === 'string' && payload.conversation_id !== '') {
    return payload.conversation_id;
  }
  return undefined;
}

function agentIdFor(session) {
  return `cursor:${createHash('sha256').update(session).digest('hex').slice(0, 8)}`;
}

function concordExecutable() {
  const overide = process.env.CONCORD_EXECUTABLE?.trim();
  if (overide) return overide;
  return process.platform === 'win32' ? 'concord.cmd' : 'concord';
}

function runConcord(root, args, output = false) {
  const result = spawnSync(concordExecutable(), args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout: 12_000,
    windowsHide: true,
    shell: process.platform === 'win32',
    stdio: output ? ['ignore', 'pipe', 'pipe'] : 'ignore',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `concord exited with status ${String(result.status)}`);
  }
  return result.stdout ?? '';
}

function register(root, agentId) {
  runConcord(root, ['inbox', 'register', '--agent', agentId, '--provider', 'cursor']);
}

function renderMessages(messages) {
  return messages
    .map((message) => {
      const task = typeof message.taskId === 'string' ? ` task=${message.taskId}` : '';
      return `[concord from ${String(message.senderAgentId)} id=${String(message.messageId)}${task}]\n${String(message.content)}`;
    })
    .join('\n\n');
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main() {
  const mode = process.argv[2];
  const payload = readPayload();
  const root = projectRoot(payload);
  const session = sessionId(payload);
  if (!session || !existsSync(join(root, '.concord', 'concord.db'))) {
    writeResult({});
    return;
  }
  const agentId = agentIdFor(session);

  if (mode === 'session-start') {
    register(root, agentId);
    writeResult({
      env: { CONCORD_AGENT_ID: agentId },
      additional_context:
        `Concord: this Cursor session is agent ${agentId}. To receive peer messages while ` +
        `idle, start exactly one Cursor background Shell task with: ` +
        `concord inbox watch --provider cursor --once. Leave it active when the turn ends so ` +
        `Cursor's background-task completion resumes you. When it completes, answer the emitted ` +
        `peer message, then immediately start a fresh monitor.`,
    });
    return;
  }

  if (mode === 'session-end') {
    writeResult({});
    return;
  }

  if (mode === 'stop') {
    register(root, agentId);
    const output = runConcord(
      root,
      ['inbox', 'drain', '--agent', agentId, '--provider', 'cursor', '--format', 'json'],
      true,
    );
    const parsed = JSON.parse(output || '[]');
    if (!Array.isArray(parsed) || parsed.length === 0) {
      writeResult({});
      return;
    }
    writeResult({ followup_message: renderMessages(parsed) });
    return;
  }

  throw new Error(`Unknown Cursor hook mode: ${String(mode)}`);
}

await main();
