import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import { junieHooksInstalled } from '../junie-hooks.js';
import { junieMcpInstalled } from '../junie-config.js';
import type { AdapterReport } from './index.js';
import { atLeast, executablePath, run, versionTuple } from './probe.js';

/**
 * Junie's adapter status: the MCP server in `~/.junie/mcp/mcp.json` plus the
 * lifecycle hooks in `~/.junie/config.json`, gated on the version that
 * verified them.
 */
export function statusJunie(env: NodeJS.ProcessEnv): AdapterReport {
  const config = HARNESS_CONFIGS.junie;
  const executable = executablePath(config.executable, env);
  if (executable === undefined) {
    return {
      harness: config.name,
      detected: false,
      status: 'not_detected',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: 'Junie CLI was not found on PATH.',
    };
  }
  const version = versionTuple(run(executable, ['--version'], env).output);
  if (version === undefined || !atLeast(version, config.minimumVersion)) {
    return {
      harness: config.name,
      detected: true,
      status: 'unsupported_version',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: config.unsupportedDetail,
    };
  }
  const mcpInstalled = junieMcpInstalled(env);
  const hooksInstalled = junieHooksInstalled(env);
  const installed = mcpInstalled && hooksInstalled;
  const missing: string[] = [];
  if (!mcpInstalled) missing.push('the Concord MCP server is not registered');
  if (!hooksInstalled) missing.push('the lifecycle hooks are missing from ~/.junie/config.json');
  return {
    harness: config.name,
    detected: true,
    status: installed ? 'installed' : 'action_required',
    monitor: config.monitor.kind,
    capabilities: installed ? [...config.installedCapabilities] : ['pull', 'busy'],
    detail: installed
      ? config.installedDetail
      : `Junie needs repair: ${missing.join(' and ')}. Run \`concord setup\` to install both.`,
  };
}
