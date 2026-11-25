import { existsSync } from 'node:fs';

import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import {
  openclawConfigInstalled,
  openclawConfigPath,
  openclawStateDir,
} from '../openclaw-config.js';
import type { AdapterReport } from './index.js';

/** OpenClaw's Gateway may run as a service without its CLI on PATH, so its state directory also counts. */
export function isOpenclawDetected(
  executable: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    executable !== undefined ||
    existsSync(openclawStateDir(env)) ||
    existsSync(openclawConfigPath(env))
  );
}

/**
 * OpenClaw's adapter status. Concord is one of OpenClaw's own `mcp.servers`,
 * launched per session without a session id, so delivery is pull-only.
 */
export function statusOpenclaw(
  executable: string | undefined,
  env: NodeJS.ProcessEnv,
): AdapterReport {
  const config = HARNESS_CONFIGS.openclaw;
  if (!isOpenclawDetected(executable, env)) {
    return report(false, 'not_detected', config.unsupportedDetail);
  }
  if (!openclawConfigInstalled(env)) {
    return report(
      true,
      'action_required',
      'Concord MCP server is not yet registered under `mcp.servers` in OpenClaw. Run `concord setup`.',
    );
  }
  return report(true, 'installed', config.installedDetail, [...config.installedCapabilities]);
}

function report(
  detected: boolean,
  status: AdapterReport['status'],
  detail: string,
  capabilities: string[] = [],
): AdapterReport {
  const config = HARNESS_CONFIGS.openclaw;
  return {
    harness: config.name,
    detected,
    status,
    monitor: config.monitor.kind,
    capabilities,
    detail,
  };
}
