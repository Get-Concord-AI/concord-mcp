import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import { executablePath } from './adapters/probe.js';
import { isOpenclawDetected } from './adapters/openclaw.js';
import { removeBlock, upsertBlock } from './block.js';
import { CONCORD_GLOBAL_INSTRUCTIONS } from './instructions.js';
import { spawnCommandSync } from './spawn-command.js';

const OPENCLAW_BLOCK = {
  start: '<!-- concord:openclaw-start -->',
  end: '<!-- concord:openclaw-end -->',
};

const rosterSchema = z.array(
  z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/u),
    workspace: z.string().refine(isAbsolute),
  }),
);

interface OpenclawWorkspaceReport {
  files: string[];
  written: string[];
  warnings: string[];
}

function physicalFile(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    // The workspace may not exist yet. Resolve its nearest existing ancestor
    // so two paths through the same symlink are grouped before either is created.
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(physicalFile(parent), basename(absolute));
  }
}

function readInstructions(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function listOpenclawAgents(executable: string, env: NodeJS.ProcessEnv) {
  // OpenClaw resolves profiles, includes and implicit workspace paths itself.
  const result = spawnCommandSync(executable, ['agents', 'list', '--json'], {
    env,
    timeout: 15_000,
  });
  if (result.status !== 0) throw new Error('Could not list OpenClaw agents.');
  return rosterSchema.parse(JSON.parse(result.stdout));
}

function workspaceRoster(
  env: NodeJS.ProcessEnv,
  warnings: string[],
): Map<string, Set<string>> | undefined {
  const byFile = new Map<string, Set<string>>();
  const executable = executablePath('openclaw', env);
  if (!isOpenclawDetected(executable, env)) return undefined;

  try {
    if (executable === undefined) throw new Error('OpenClaw CLI is missing');
    for (const { id, workspace } of listOpenclawAgents(executable, env)) {
      const path = physicalFile(join(workspace, 'AGENTS.md'));
      const agents = byFile.get(path) ?? new Set<string>();
      agents.add(id);
      byFile.set(path, agents);
    }
  } catch {
    warnings.push(
      'Could not read OpenClaw agent workspaces. Check openclaw agents list --json, or set each agent ID in its AGENTS.md manually.',
    );
    return undefined;
  }
  return byFile;
}

export function applyOpenclawWorkspaces(
  env: NodeJS.ProcessEnv,
  enable: boolean,
  previous: readonly string[],
): OpenclawWorkspaceReport {
  const report: OpenclawWorkspaceReport = { files: [], written: [], warnings: [] };
  const roster = enable ? workspaceRoster(env, report.warnings) : new Map<string, Set<string>>();
  if (roster === undefined) {
    report.files.push(...previous);
    return report;
  }
  const paths = new Set([...roster.keys(), ...previous.map(physicalFile)]);

  for (const path of paths) {
    const agents = [...(roster.get(path) ?? [])];
    const agent = agents.length === 1 ? agents[0] : undefined;
    if (agents.length > 1) {
      report.warnings.push(
        `${path}: OpenClaw agents ${agents.join(', ')} share a workspace. Give them separate workspaces or supply their own agent IDs manually.`,
      );
    }
    try {
      const existing = readInstructions(path);
      const next =
        agent === undefined
          ? removeBlock(existing ?? '', OPENCLAW_BLOCK)
          : upsertBlock(
              existing ?? '',
              `${CONCORD_GLOBAL_INSTRUCTIONS}

As OpenClaw agent \`${agent}\`, pass \`agent_id: "openclaw:${agent}"\` on Concord
workflow writes and \`kind: "openclaw"\` to \`start_work\`. Use your own agent ID
to read your inbox with \`inspect_work\`.`,
              OPENCLAW_BLOCK,
            );
      if (next !== (existing ?? '')) {
        if (next === '') {
          rmSync(path);
        } else {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, next);
        }
        report.written.push(path);
      }
      if (agent !== undefined) report.files.push(path);
    } catch (error) {
      // Keep a failed path so the next setup or uninstall retries it.
      report.files.push(path);
      report.warnings.push(`${path}: ${String(error)}`);
    }
  }
  return report;
}
