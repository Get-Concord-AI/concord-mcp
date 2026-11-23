import { existsSync, readFileSync } from 'node:fs';

import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import {
  clineDetected,
  clineGlobalHookDirs,
  clineHooksPresent,
  clineMcpSettingsPath,
  installClineUserConfigs,
} from '../cline-config.js';
import { hasMcpServer } from '../mcp-config.js';
import { atLeast, executablePath, run, versionTuple } from './probe.js';
import type { AdapterReport } from './index.js';

type FileState = 'present' | 'missing' | 'unreadable';

function mcpState(env: NodeJS.ProcessEnv): FileState {
  const path = clineMcpSettingsPath(env);
  if (!existsSync(path)) return 'missing';
  try {
    return hasMcpServer(readFileSync(path, 'utf8')) ? 'present' : 'missing';
  } catch {
    return 'unreadable';
  }
}

/**
 * The canonical hook directory is `~/Documents/Cline/Hooks`: the only global
 * directory the VS Code extension reads, and one the SDK scans as well. The
 * `~/.cline/hooks` copy is belt-and-suspenders for SDK-only layouts.
 */
type HookState = 'present' | 'missing' | 'partial';

function hooksState(env: NodeJS.ProcessEnv): HookState {
  const states = clineGlobalHookDirs(env).map((dir) => clineHooksPresent(dir));
  if (states.includes('present')) return 'present';
  return states.includes('partial') ? 'partial' : 'missing';
}

function report(
  status: AdapterReport['status'],
  detail: string,
  capabilities: readonly string[] = [],
): AdapterReport {
  const config = HARNESS_CONFIGS.cline;
  return {
    harness: config.name,
    detected: status !== 'not_detected',
    status,
    monitor: config.monitor.kind,
    capabilities: [...capabilities],
    detail,
  };
}

/**
 * Cline's adapter status. Cline has one global MCP settings file for every
 * project and no MCP roots capability, so delivery is busy-pull everywhere:
 * lifecycle hooks register each task and, in the VS Code extension, inject
 * inbox messages on prompt submit — but nothing wakes an idle session.
 */
export function statusCline(
  executable: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AdapterReport {
  const config = HARNESS_CONFIGS.cline;
  if (!clineDetected(env)) {
    return report(
      'not_detected',
      'Cline was not found on PATH, in ~/.cline, in ~/Documents/Cline, or as a VS Code extension.',
    );
  }
  if (executable !== undefined) {
    const version = versionTuple(run(executable, ['--version'], env).output);
    if (version !== undefined && !atLeast(version, config.minimumVersion)) {
      return report('unsupported_version', config.unsupportedDetail);
    }
  }

  const mcp = mcpState(env);
  if (mcp === 'unreadable') {
    return report(
      'action_required',
      'Cline MCP settings could not be read. Check cline_mcp_settings.json and its permissions.',
    );
  }

  const hooks = hooksState(env);
  if (mcp === 'present' && hooks === 'present') {
    return report('installed', config.installedDetail, config.installedCapabilities);
  }
  if (mcp === 'present') {
    return report(
      'action_required',
      'Cline has the Concord MCP server but not its lifecycle hooks, so messages wait in the durable inbox. Run `concord setup` to add them.',
      ['pull', 'busy'],
    );
  }
  if (hooks === 'partial') {
    return report(
      'action_required',
      'Some Concord Cline hooks are installed but incomplete. Run `concord setup` to repair them.',
    );
  }
  return report(
    'action_required',
    'Cline needs the Concord MCP server in its global MCP settings. Run `concord setup`.',
  );
}

/** Install Cline's user-level MCP registration and global lifecycle hooks. */
export function installCline(env: NodeJS.ProcessEnv): void {
  if (!clineDetected(env)) return;
  const executable = executablePath(HARNESS_CONFIGS.cline.executable, env);
  if (executable !== undefined) {
    const version = versionTuple(run(executable, ['--version'], env).output);
    if (version !== undefined && !atLeast(version, HARNESS_CONFIGS.cline.minimumVersion)) {
      return;
    }
  }
  installClineUserConfigs(env);
}
