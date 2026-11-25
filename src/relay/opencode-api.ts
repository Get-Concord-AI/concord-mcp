import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Talks to a running OpenCode 2 server through `opencode api`.
 *
 * The server rejects unauthenticated HTTP, and the CLI already knows how to
 * authenticate against the shared background service, so Concord shells out
 * instead of managing credentials. Errors arrive as JSON on stdout with a
 * non-zero exit code.
 */

/** One API call; resolves with the response body (JSON text), rejects on failure. */
export type OpenCodeRequest = (
  method: 'GET' | 'POST',
  path: string,
  body?: string,
) => Promise<string>;

const DESKTOP_CLI_DIR = ['ai.opencode.desktop', 'cli'];
const REQUEST_TIMEOUT_MS = 15_000;

/** `2.2.3-x64` → [2, 2, 3]; anything else sorts last. */
function versionOf(directory: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(directory);
  return match === null ? [-1] : match.slice(1).map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The `opencode` binary to run. `CONCORD_OPENCODE_BIN` wins; then the CLI the
 * desktop app bundles (newest version, as it is not on PATH); then `opencode`
 * on PATH.
 */
export function findOpenCodeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CONCORD_OPENCODE_BIN']?.trim();
  if (override !== undefined && override !== '') return override;
  const appData = env['APPDATA'];
  if (appData !== undefined) {
    const root = join(appData, ...DESKTOP_CLI_DIR);
    if (existsSync(root)) {
      const versions = readdirSync(root).sort((a, b) =>
        compareVersions(versionOf(b), versionOf(a)),
      );
      for (const version of versions) {
        const candidate = join(root, version, 'opencode-cli.exe');
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return 'opencode';
}

/** Build a request function that spawns `opencode api`, optionally against `server`. */
export function openCodeApiRunner(executable: string, server?: string): OpenCodeRequest {
  return (method, path, body) => {
    const args = ['api'];
    if (server !== undefined) args.push('--server', server);
    if (body !== undefined) args.push('--data', body);
    args.push(method, path);
    return new Promise((resolve, reject) => {
      execFile(
        executable,
        args,
        { timeout: REQUEST_TIMEOUT_MS, windowsHide: true },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(stdout);
            return;
          }
          const detail = (stdout.trim() || stderr.trim() || error.message).slice(0, 300);
          reject(new Error(`opencode api ${method} ${path} failed: ${detail}`));
        },
      );
    });
  };
}
