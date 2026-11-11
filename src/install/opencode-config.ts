import { z } from 'zod';

import { CONCORD_SERVER_COMMAND, CONCORD_SERVER_KEY } from './mcp-config.js';
import { spawnCommandSync } from './spawn-command.js';

/**
 * OpenCode 2's user-level registration of Concord's MCP server.
 *
 * OpenCode owns its config file (`opencode.json` or `opencode.jsonc`, with
 * comments, trailing commas and other servers a user may have), so Concord asks
 * `opencode mcp add --global` to write the entry instead of parsing and
 * rewriting the file itself; that command is idempotent and leaves everything
 * else in the file untouched. Registration is read back from the server's
 * `GET /api/mcp`.
 *
 * The entry pins only the harness kind. OpenCode sends its session id in each
 * MCP request's metadata rather than the server's environment, and the server
 * derives the agent from it per request.
 */

const OPENCODE_KIND = 'opencode';
const COMMAND_TIMEOUT_MS = 30_000;

const serversSchema = z.object({
  data: z.array(z.object({ name: z.string(), status: z.object({ status: z.string() }).loose() })),
});

/** Register (or refresh) Concord's MCP server in OpenCode's global config; throws on failure. */
export function installOpencodeMcpConfig(executable: string, env: NodeJS.ProcessEnv): void {
  const result = spawnCommandSync(
    executable,
    [
      'mcp',
      'add',
      '--global',
      '--env',
      `CONCORD_AGENT_KIND=${OPENCODE_KIND}`,
      CONCORD_SERVER_KEY,
      '--',
      CONCORD_SERVER_COMMAND,
    ],
    { env, timeout: COMMAND_TIMEOUT_MS },
  );
  if (result.status !== 0) {
    const detail = result.error?.message ?? `${result.stdout}${result.stderr}`.trim();
    throw new Error(`opencode mcp add failed: ${detail.slice(0, 300)}`);
  }
}

/**
 * Whether OpenCode's background service is running. Unlike `opencode api` and
 * `opencode mcp list`, which start the service when it is stopped (and, on a
 * port already taken, stall for about 20 seconds before failing),
 * `opencode service status` only reports: the server URL, or `stopped`.
 */
export function opencodeServiceRunning(executable: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnCommandSync(executable, ['service', 'status'], {
    env,
    timeout: COMMAND_TIMEOUT_MS,
  });
  return result.status === 0 && /^https?:\/\//u.test(result.stdout.trim());
}

/** Whether OpenCode lists Concord's server and has not disabled it. Starts the service if stopped. */
export function opencodeConfigInstalled(executable: string, env: NodeJS.ProcessEnv): boolean {
  const result = spawnCommandSync(executable, ['api', 'GET', '/api/mcp'], {
    env,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.status !== 0) return false;
  try {
    const parsed = serversSchema.safeParse(JSON.parse(result.stdout));
    return (
      parsed.success &&
      parsed.data.data.some(
        (server) => server.name === CONCORD_SERVER_KEY && server.status.status !== 'disabled',
      )
    );
  } catch {
    return false;
  }
}
