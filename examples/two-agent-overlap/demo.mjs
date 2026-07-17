// End-to-end demo: two agents claim overlapping work, then one hands off and
// marks the task review-ready. Drives the real Concord MCP server over stdio
// and prints the artifacts it produces. Run with `pnpm demo` (builds first).

import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, '..', '..', 'dist', 'index.js');

// Run in a throwaway repo so the demo never touches this project's own .concord/.
const workdir = mkdtempSync(join(tmpdir(), 'concord-demo-'));
mkdirSync(join(workdir, '.git'));

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

console.log('# Concord — two-agent overlap demo\n');

console.log('$ claude-code claims TASK-12');
console.log(
  await call('claim_work', {
    task_id: 'TASK-12',
    title: 'Add Stripe retry handling',
    agent: 'claude-code',
    branch: 'feat/billing-retry',
    modules: ['billing', 'stripe'],
    expected_files: ['src/billing/retry.ts'],
  }),
  '\n',
);

console.log('$ codex claims TASK-14 (also touches billing)');
console.log(
  await call('claim_work', {
    task_id: 'TASK-14',
    title: 'Fix invoice totals',
    agent: 'codex',
    modules: ['billing'],
    expected_files: ['src/billing/invoices.ts'],
  }),
  '\n',
);

console.log('$ claude-code hands off TASK-12');
console.log(
  await call('handoff', {
    task_id: 'TASK-12',
    status: 'done',
    what_changed: 'Queued retries instead of blocking checkout',
    changed_files: ['src/billing/retry.ts'],
    tests_run: ['pnpm test billing'],
    decisions: ['Use a queued retry so user-path calls never block checkout'],
    needs_review_from: ['payments-team'],
  }),
  '\n',
);

console.log('$ claude-code marks TASK-12 review-ready');
console.log(
  await call('review_ready', {
    task_id: 'TASK-12',
    plan_summary: 'Queue Stripe retries instead of blocking checkout',
    tests_run: ['pnpm test billing'],
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

await client.close();

const concord = join(workdir, '.concord');
console.log(`Artifacts written to ${concord}:`);
console.log('  ' + readdirSync(concord).join(', ') + '\n');
console.log('----- REVIEW_PACKET.md -----');
console.log(readFileSync(join(concord, 'REVIEW_PACKET.md'), 'utf8'));
