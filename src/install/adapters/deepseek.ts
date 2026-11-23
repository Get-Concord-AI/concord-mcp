import { existsSync, readFileSync } from 'node:fs';

import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import { deepseekConfigPath, hasDeepseekConfig } from '../deepseek-config.js';
import type { AdapterReport } from './index.js';

/** Native MCP registration does not imply that DSH can wake an idle agent. */
export function statusDeepseek(
  executable: string | undefined,
  env: NodeJS.ProcessEnv,
): AdapterReport {
  const config = HARNESS_CONFIGS.deepseek;
  const path = deepseekConfigPath(env);
  let installed = false;
  let detail = 'DeepSeek Harness needs a Concord MCP entry in its cordis.patch.yml.';
  if (executable !== undefined && existsSync(path)) {
    try {
      installed = hasDeepseekConfig(readFileSync(path, 'utf8'));
    } catch {
      detail = 'DeepSeek Harness cordis.patch.yml could not be read. Check its permissions.';
    }
  }
  return {
    harness: config.name,
    detected: executable !== undefined,
    status: executable === undefined ? 'not_detected' : installed ? 'installed' : 'action_required',
    monitor: config.monitor.kind,
    capabilities: installed ? [...config.installedCapabilities] : [],
    detail:
      executable === undefined
        ? 'DeepSeek Harness (dsh) was not found on PATH.'
        : installed
          ? config.installedDetail
          : detail,
    ...(installed ? { installedPath: path } : {}),
  };
}
