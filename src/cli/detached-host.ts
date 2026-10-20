import { spawn } from 'node:child_process';

/**
 * Start this CLI again, detached, as a long-lived host for one session — the
 * process that steers a Codex thread or a Copilot CLI session. It runs from
 * the repository root and outlives the hook that started it.
 */
export function launchDetachedConcord(
  repoRoot: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) return;
  const child = spawn(process.execPath, [entrypoint, '--repo', repoRoot, ...args], {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
