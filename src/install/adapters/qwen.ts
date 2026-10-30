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
  if (executable === undefined) {
    return report('not_detected', 'Qwen Code was not found on PATH.');
  }
  const registered = qwenRegistered(repoRoot);
  if (registered === 'unreadable') {
    return report(
      'action_required',
      'Qwen Code settings in .qwen/settings.json could not be read. Check the file and its permissions.',
    );
  }
  if (!registered) {
    return report(
      'action_required',
      'Qwen Code needs the Concord MCP server in .qwen/settings.json.',
    );
  }
  return report('installed', config.installedDetail, config.installedCapabilities);
}

/** Whether the project's Qwen settings register Concord, or 'unreadable' if the file exists but cannot be read. */
function qwenRegistered(repoRoot: string | undefined): boolean | 'unreadable' {
  if (repoRoot === undefined) return false;
  const settingsPath = join(repoRoot, QWEN_SETTINGS);
  if (!existsSync(settingsPath)) return false;
  try {
    return hasMcpServer(readFileSync(settingsPath, 'utf8'));
  } catch {
    return 'unreadable';
  }
}

function report(
  status: AdapterReport['status'],
  detail: string,
  capabilities: readonly string[] = [],
): AdapterReport {
  const config = HARNESS_CONFIGS.qwen;
  return {
    harness: config.name,
    detected: status !== 'not_detected',
    status,
    monitor: config.monitor.kind,
    capabilities: [...capabilities],
    detail,
  };
}
