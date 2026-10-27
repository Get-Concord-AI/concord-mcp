import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { TestProject } from 'vitest/node';

import { e2eRoot, REPO_ROOT } from './support/sandbox.js';

declare module 'vitest' {
  export interface ProvidedContext {
    concordPrefix: string;
  }
}

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

/**
 * Build, pack, and install Concord once per run, exactly as a user gets it
 * from npm: only the files the package publishes, with its own dependencies.
 * `CONCORD_E2E_SKIP_BUILD=1` reuses an existing `dist/`.
 */
export default function setup(project: TestProject): void {
  const root = e2eRoot();
  const packDir = join(root, 'pack');
  const prefix = join(root, 'prefix');
  rmSync(packDir, { recursive: true, force: true });
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });

  if (process.env['CONCORD_E2E_SKIP_BUILD'] !== '1') run('pnpm', ['build'], REPO_ROOT);
  // `npm pack`, as releases use `npm publish`: `pnpm pack` drops the executable
  // bit from plugin scripts such as the Claude monitor's watch-inbox.sh.
  run('npm', ['pack', '--pack-destination', packDir, '--ignore-scripts'], REPO_ROOT);
  const tarball = readdirSync(packDir).find((file) => file.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('npm pack produced no tarball.');
  run(
    'npm',
    ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', join(packDir, tarball)],
    root,
  );
  project.provide('concordPrefix', prefix);
}
