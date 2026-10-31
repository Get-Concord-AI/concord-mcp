import { join } from 'node:path';

import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import { inspectOpenCodeMcpConfig, installOpenCodeMcpConfig } from '../opencode-config.js';
import type { AdapterReport } from './index.js';
import { atLeast, executablePath, run, versionTuple } from './runtime.js';

/** True only for the OpenCode V2 contract used by this integration. */
export function openCodeSupportsV2(env: NodeJS.ProcessEnv = process.env): boolean {
  const executable = executablePath(HARNESS_CONFIGS.opencode.executable, env);
  if (executable === undefined) return false;
  const version = versionTuple(run(executable, ['--version'], env).output);
  return version !== undefined && atLeast(version, HARNESS_CONFIGS.opencode.minimumVersion);
}

export function statusOpenCode(env: NodeJS.ProcessEnv, repoRoot?: string): AdapterReport {
  const config = HARNESS_CONFIGS.opencode;
  const executable = executablePath(config.executable, env);
  const root = repoRoot ?? process.cwd();
  let configState;
  try {
    configState = inspectOpenCodeMcpConfig(root);
  } catch (error) {
    return {
      harness: config.name,
      detected: executable !== undefined,
      status: 'error',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const installedPath = join(root, configState.relPath);
  if (executable === undefined) {
    return {
      harness: config.name,
      detected: false,
      status: 'not_detected',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: 'OpenCode CLI was not found on PATH.',
      ...(configState.kind === 'configured' ? { installedPath } : {}),
    };
  }

  const tuple = versionTuple(run(executable, ['--version'], env).output);
  if (tuple === undefined || !atLeast(tuple, config.minimumVersion)) {
    return {
      harness: config.name,
      detected: true,
      status: 'unsupported_version',
      monitor: config.monitor.kind,
      capabilities: [],
      detail: config.unsupportedDetail,
      ...(configState.kind === 'configured' ? { installedPath } : {}),
    };
  }

  if (configState.kind === 'configured') {
    return {
      harness: config.name,
      detected: true,
      status: 'installed',
      monitor: config.monitor.kind,
      capabilities: [...config.installedCapabilities],
      detail: config.installedDetail,
      installedPath,
    };
  }

  const detail =
    configState.kind === 'disabled'
      ? 'Concord is registered in OpenCode but disabled in this repository config.'
      : configState.kind === 'custom'
        ? 'A custom Concord MCP entry exists; review it before replacing it.'
        : `Concord MCP is not registered in ${configState.relPath}.`;
  return {
    harness: config.name,
    detected: true,
    status: 'action_required',
    monitor: config.monitor.kind,
    capabilities: [],
    detail,
    installedPath,
  };
}

export function installOpenCode(env: NodeJS.ProcessEnv, repoRoot: string): void {
  if (openCodeSupportsV2(env)) installOpenCodeMcpConfig(repoRoot);
}
