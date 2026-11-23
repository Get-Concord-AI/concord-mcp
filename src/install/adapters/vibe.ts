import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import { vibeMcpInstalled } from '../vibe-config.js';
import { vibeHooksPresent } from '../vibe-hooks.js';
import type { AdapterReport } from './index.js';
import { atLeast, run, versionTuple } from './probe.js';

/**
 * Vibe's adapter status. Delivery is busy-only: Vibe has no verified idle
 * wake-up channel, so an installed session never reports idle reachability.
 */
export function statusVibe(executable: string | undefined, env: NodeJS.ProcessEnv): AdapterReport {
  const config = HARNESS_CONFIGS.vibe;
  if (executable === undefined) {
    return report('not_detected', 'Mistral Vibe was not found on PATH.');
  }
  const version = versionTuple(run(executable, ['--version'], env).output);
  if (version === undefined || !atLeast(version, config.minimumVersion)) {
    return report('unsupported_version', config.unsupportedDetail);
  }
  const installed = vibeMcpInstalled(env) && vibeHooksPresent(env);
  return report(
    installed ? 'installed' : 'action_required',
    installed
      ? config.installedDetail
      : 'Mistral Vibe needs the Concord MCP server and lifecycle hooks installed.',
    installed ? config.installedCapabilities : [],
  );
}

function report(
  status: AdapterReport['status'],
  detail: string,
  capabilities: readonly string[] = [],
): AdapterReport {
  const config = HARNESS_CONFIGS.vibe;
  return {
    harness: config.name,
    detected: status !== 'not_detected',
    status,
    monitor: config.monitor.kind,
    capabilities: [...capabilities],
    detail,
  };
}
