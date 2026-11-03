import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import { findOpenCodeExecutable } from '../../relay/opencode-api.js';
import { installOpencodeMcpConfig, opencodeConfigInstalled } from '../opencode-config.js';
import type { AdapterReport } from './index.js';
import { atLeast, executablePath, run, versionTuple } from './probe.js';

/** The desktop app bundles its own CLI off PATH, so look there before PATH. */
export function opencodeExecutable(env: NodeJS.ProcessEnv): string | undefined {
  const found = findOpenCodeExecutable(env);
  return found === 'opencode' ? executablePath('opencode', env) : found;
}

export function statusOpencode(env: NodeJS.ProcessEnv): AdapterReport {
  const config = HARNESS_CONFIGS.opencode;
  const executable = opencodeExecutable(env);
  const base = { harness: config.name, monitor: config.monitor.kind };
  const probe = executable === undefined ? undefined : run(executable, ['--version'], env);
  if (executable === undefined || probe?.ok !== true) {
    return {
      ...base,
      detected: false,
      status: 'not_detected',
      capabilities: [],
      detail: 'OpenCode was not found on PATH or in the desktop app.',
    };
  }
  const version = versionTuple(probe.output);
  if (version === undefined || !atLeast(version, config.minimumVersion)) {
    return {
      ...base,
      detected: true,
      status: 'unsupported_version',
      capabilities: [],
      detail: config.unsupportedDetail,
    };
  }
  const installed = opencodeConfigInstalled(executable, env);
  return {
    ...base,
    detected: true,
    status: installed ? 'installed' : 'action_required',
    capabilities: installed ? [...config.installedCapabilities] : [],
    detail: installed
      ? config.installedDetail
      : 'OpenCode needs the Concord MCP server registered with it.',
  };
}

/** Register Concord with OpenCode when a supported OpenCode is present; throws on failure. */
export function installOpencode(env: NodeJS.ProcessEnv): void {
  const executable = opencodeExecutable(env);
  if (executable === undefined) return;
  const version = versionTuple(run(executable, ['--version'], env).output);
  if (version === undefined || !atLeast(version, HARNESS_CONFIGS.opencode.minimumVersion)) return;
  installOpencodeMcpConfig(executable, env);
}
