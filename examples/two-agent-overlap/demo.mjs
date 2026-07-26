// End-to-end demo: two agents claim overlapping work, then one hands off and
// marks the task review-ready. Drives the real Concord MCP server over stdio
// and prints the artifacts it produces. Run with `pnpm demo` (builds first).

import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, '..', '..', 'dist', 'index.js');

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const requestedDir = option('--dir');
const workdir =
  requestedDir === undefined ? mkdtempSync(join(tmpdir(), 'concord-demo-')) : resolve(requestedDir);
const delayMs = Number.parseInt(option('--delay') ?? '0', 10);
if (!Number.isFinite(delayMs) || delayMs < 0) {
  throw new Error('--delay must be a non-negative number of milliseconds');
}

// Default to a throwaway repo; --dir lets a second terminal watch the real flow.
mkdirSync(join(workdir, '.git'), { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: workdir,
});
const client = new Client({ name: 'concord-demo', version: '0.0.0' });
await client.connect(transport);

function text(result) {
  const first = result.content[0];
  return first && first.type === 'text' ? first.text : '';
}

async function call(name, args) {
  return text(await client.callTool({ name, arguments: args }));
}

async function pause() {
  await new Promise((resolvePause) => {
    setTimeout(resolvePause, delayMs);
  });
}

console.log('# Concord — two-agent overlap demo\n');
console.log(`Workspace: ${workdir}`);
console.log(`Watch live: (cd ${JSON.stringify(workdir)} && concord dashboard)\n`);

console.log('$ claude-code and codex register their presence');
console.log(
  await call('register_agent', {
    agent_id: 'claude-code:demo',
    kind: 'claude-code',
    summary: 'Adding Stripe retry handling',
  }),
);
console.log(
  await call('register_agent', {
    agent_id: 'codex:demo',
    kind: 'codex',
    summary: 'Fixing invoice totals',
  }),
  '\n',
);
await pause();

console.log('$ claude-code claims TASK-12');
console.log(
  await call('claim_work', {
    task_id: 'TASK-12',
    title: 'Add Stripe retry handling',
    agent: 'claude-code',
    agent_id: 'claude-code:demo',
    branch: 'feat/billing-retry',
    modules: ['billing', 'stripe'],
    expected_files: ['src/billing/retry.ts'],
  }),
  '\n',
);
await pause();

console.log('$ claude-code records task context as it works');
console.log(
  await call('update_task', {
    task_id: 'TASK-12',
    kind: 'intent',
    content: 'Keep checkout responsive when Stripe retries are needed',
    agent_id: 'claude-code:demo',
  }),
);
console.log(
  await call('update_task', {
    task_id: 'TASK-12',
    kind: 'decision',
    content: 'Use a queued retry so user-path calls never block checkout',
    agent_id: 'claude-code:demo',
  }),
  '\n',
);
await pause();

console.log('$ codex claims TASK-14 (also touches billing)');
console.log(
  await call('claim_work', {
    task_id: 'TASK-14',
    title: 'Fix invoice totals',
    agent: 'codex',
    agent_id: 'codex:demo',
    modules: ['billing'],
    expected_files: ['src/billing/invoices.ts'],
  }),
  '\n',
);
await pause();

console.log('$ codex reads TASK-12 context before coordinating');
console.log(await call('get_task_context', { task_id: 'TASK-12' }), '\n');

console.log('$ claude-code hands off TASK-12 and marks it review-ready');
console.log(
  await call('handoff', {
    task_id: 'TASK-12',
    agent_id: 'claude-code:demo',
    status: 'done',
    what_changed: 'Queued retries instead of blocking checkout',
    changed_files: ['src/billing/retry.ts'],
    tests_run: ['pnpm test billing'],
    decisions: ['Use a queued retry so user-path calls never block checkout'],
    needs_review_from: ['payments-team'],
    ready_for_review: true,
    diff_size: '+120 / -30',
    guardrails_checked: ['Stripe changes covered by an artificial payment test'],
    open_questions: ['Notify the account owner immediately or only after the final retry?'],
    provenance: [
      { field: 'plan', source: 'agent reported' },
      { field: 'tests', source: 'command output' },
    ],
  }),
  '\n',
);
await pause();

await client.close();

const concord = join(workdir, '.concord');
console.log(`Artifacts written to ${concord}:`);
console.log('  ' + readdirSync(concord).join(', ') + '\n');
console.log('----- REVIEW_PACKET.md -----');
console.log(readFileSync(join(concord, 'REVIEW_PACKET.md'), 'utf8'));
