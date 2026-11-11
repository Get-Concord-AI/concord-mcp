import { existsSync, readFileSync } from 'node:fs';

import { HARNESS_CONFIGS } from '../../domain/harness-config.js';
import {
  hasKiroHooks,
  kiroDetected,
  kiroUserHooksPath,
  kiroUserMcpPath,
  kiroWorkspaceHooksPath,
  kiroWorkspaceMcpPath,
} from '../kiro-config.js';
import { hasMcpServer } from '../mcp-config.js';
import type { AdapterReport } from './index.js';
import { atLeast, run, versionTuple } from './probe.js';

type FileState = 'present' | 'missing' | 'unreadable';

function readState(path: string, accepts: (content: string) => boolean): FileState {
  if (!existsSync(path)) return 'missing';
  try {
    return accepts(readFileSync(path, 'utf8')) ? 'present' : 'missing';
  } catch {
    return 'unreadable';
  }
}

function combine(left: FileState, right: FileState): FileState {
  if (left === 'unreadable' || right === 'unreadable') return 'unreadable';
  return left === 'present' || right === 'present' ? 'present' : 'missing';
}

function report(
  status: AdapterReport['status'],
  detail: string,
  capabilities: readonly string[] = [],
): AdapterReport {
  const config = HARNESS_CONFIGS.kiro;
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
 * Kiro's adapter status. Delivery is busy-only: Kiro hooks fire on session
 * start, prompt submit, and turn end but never wake an idle session, so an
 * installed Kiro session reports pull only - never idle reachability.
 */
export function statusKiro(
  executable: string | undefined,
  repoRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cli?: string,
): AdapterReport {
  const config = HARNESS_CONFIGS.kiro;
  if (!kiroDetected(executable, repoRoot, env)) {
    return report('not_detected', 'Kiro was not found on PATH, in ~/.kiro, or in .kiro.');
  }

  // A launcher-only install is the IDE, whose hook support predates the CLI
  // check below; only a real CLI can be version-gated.
  const versionOutput = cli === undefined ? undefined : run(cli, ['--version'], env).output;
  const version = versionOutput === undefined ? undefined : versionTuple(versionOutput);
  const cliSupportsHooks =
    cli === undefined || (version !== undefined && atLeast(version, config.minimumVersion));

  const mcp = combine(
    repoRoot === undefined
      ? 'missing'
      : readState(kiroWorkspaceMcpPath(repoRoot), (content) => hasMcpServer(content)),
    readState(kiroUserMcpPath(env), (content) => hasMcpServer(content)),
  );
  if (mcp === 'unreadable') {
    return report(
      'action_required',
      'Kiro MCP settings could not be read. Check the file and its permissions.',
    );
  }

  const hooks = combine(
    repoRoot === undefined
      ? 'missing'
      : readState(kiroWorkspaceHooksPath(repoRoot), (content) => hasKiroHooks(content)),
    readState(kiroUserHooksPath(env), (content) => hasKiroHooks(content)),
  );
  if (hooks === 'unreadable') {
    return report(
      'action_required',
      'Kiro hooks could not be read. Check .kiro/hooks/concord.json and its permissions.',
    );
  }

  if (mcp === 'present' && !cliSupportsHooks) {
    const versionText = versionOutput?.trim();
    return report(
      'unsupported_version',
      `Kiro CLI${versionText === undefined || versionText === '' ? '' : ` ${versionText}`} is older than ${config.minimumVersion.join('.')}, so its lifecycle hooks cannot run. Update Kiro CLI or use Kiro IDE 1.0+; messages wait in the durable inbox until then.`,
      ['pull'],
    );
  }
  if (mcp === 'present' && hooks === 'present') {
    return report('installed', config.installedDetail, config.installedCapabilities);
  }
  if (mcp === 'present') {
    return report(
      'action_required',
      'Kiro has the Concord MCP server but not its lifecycle hooks, so messages wait in the durable inbox. Run `concord setup` to add them.',
      ['pull'],
    );
  }
  return report('action_required', 'Kiro needs the Concord MCP server in .kiro/settings/mcp.json.');
}
