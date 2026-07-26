import type { Command } from '@commander-js/extra-typings';
import { render } from 'ink';

import { DashboardApp } from '../dashboard/app.js';
import { buildDashboardSnapshot } from '../dashboard/model.js';
import { openContext } from '../context.js';

export const DASHBOARD_TTY_ERROR =
  'concord dashboard needs an interactive terminal. Use `concord status` for plain-text output.';

export async function runDashboard(
  cwd: string,
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(DASHBOARD_TTY_ERROR);
  }

  const context = openContext(cwd);
  const loadSnapshot = (): ReturnType<typeof buildDashboardSnapshot> =>
    buildDashboardSnapshot(context.repoRoot, context.repos);

  try {
    const app = render(
      <DashboardApp initialSnapshot={loadSnapshot()} loadSnapshot={loadSnapshot} />,
      {
        stdin,
        stdout,
        exitOnCtrlC: true,
        incrementalRendering: true,
      },
    );
    await app.waitUntilExit();
  } finally {
    context.repos.db.close();
  }
}

export function registerDashboardCommand(program: Command): void {
  program
    .command('dashboard')
    .description('Open a live, read-only view of agents, tasks, alerts, and activity')
    .action(async () => {
      try {
        await runDashboard(process.cwd());
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      }
    });
}
