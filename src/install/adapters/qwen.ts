import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import { hasMcpServer } from '../mcp-config.js';
import type { AdapterReport } from './index.js';

const QWEN_SETTINGS = join('.qwen', 'settings.json');

/**
 * Qwen Code's adapter status. Delivery is busy-only, so an installed Qwen
 * session never reports idle reachability: idle wake-up is not verified.
 */
export function statusQwen(
  executable: string | undefined,
  repoRoot: string | undefined,
): AdapterReport {
  const config = HARNESS_CONFIGS.qwen;
  const settingsPath = repoRoot === undefined ? undefined : join(repoRoot, QWEN_SETTINGS);
  const mcpInstalled =
    settingsPath !== undefined &&
    existsSync(settingsPath) &&
    hasMcpServer(readFileSync(settingsPath, 'utf8'));
  const installed = executable !== undefined && mcpInstalled;
  return {
    harness: config.name,
    detected: executable !== undefined,
    status: executable === undefined ? 'not_detected' : installed ? 'installed' : 'action_required',
    monitor: config.monitor.kind,
    capabilities: installed ? [...config.installedCapabilities] : [],
    detail:
      executable === undefined
        ? 'Qwen Code was not found on PATH.'
        : installed
          ? config.installedDetail
          : 'Qwen Code needs the Concord MCP server in .qwen/settings.json.',
  };
}
