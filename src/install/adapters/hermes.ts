import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import { hermesConfigInstalled, installHermesMcpConfig } from '../hermes-config.js';
import type { AdapterReport } from './index.js';
import { atLeast, versionTuple } from './probe.js';

/** Whether `hermes --version` printed a version this adapter supports. */
function supported(versionOutput: string): boolean {
  const version = versionTuple(versionOutput);
  return version !== undefined && atLeast(version, HARNESS_CONFIGS.hermes.minimumVersion);
}

/**
 * Hermes Agent's adapter status. `versionOutput` runs `hermes --version`, and
 * only once Hermes was found on PATH.
 */
export function statusHermes(
  executable: string | undefined,
  versionOutput: () => string,
  env: NodeJS.ProcessEnv,
): AdapterReport {
  const config = HARNESS_CONFIGS.hermes;
  const report = (
    status: AdapterReport['status'],
    detail: string,
    capabilities: readonly string[] = [],
  ): AdapterReport => ({
    harness: config.name,
    detected: status !== 'not_detected',
    status,
    monitor: config.monitor.kind,
    capabilities: [...capabilities],
    detail,
  });
  if (executable === undefined)
    return report('not_detected', 'Hermes Agent was not found on PATH.');
  if (!supported(versionOutput())) return report('unsupported_version', config.unsupportedDetail);
  if (!hermesConfigInstalled(env)) {
    return report(
      'action_required',
      'Hermes needs the Concord MCP server and its pre_llm_call hook in config.yaml.',
    );
  }
  return report('installed', config.installedDetail, config.installedCapabilities);
}

/** Register Concord with a supported Hermes; an unsupported one is left alone. */
export function installHermes(versionOutput: string, env: NodeJS.ProcessEnv): void {
  if (supported(versionOutput)) installHermesMcpConfig(env);
}
