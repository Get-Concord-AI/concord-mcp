import type { Command } from '@commander-js/extra-typings';

import { resolveIdentity } from '../../domain/identity.js';
import { fetchSharedFile } from '../../tools/shared-files.js';
import { resolveAgentId } from '../agent-identity.js';
import { openContext } from '../context.js';

/**
 * The agent a retrieval acts as. Retrieval reads another agent's file, so where
 * this session can be identified, `--agent` must name that session: naming
 * someone else would read their mail. Where no session is visible, the named
 * agent is trusted, as elsewhere in Concord.
 */
export function retrievingAgentId(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const agentId = resolveAgentId(explicit, env);
  const own = resolveIdentity(env);
  if (own !== undefined && own.agentId !== agentId) {
    throw new Error(
      `This session is agent ${own.agentId}; it cannot save files shared with ${agentId}.`,
    );
  }
  return agentId;
}

/**
 * Retrieval is a CLI command rather than an MCP tool: saving a file writes to
 * disk, and the workflow surface stays at five tools. Agents run it from their
 * shell with the path the message gave them.
 */
export function registerFilesCommand(program: Command): void {
  const files = program
    .command('files')
    .description('Retrieve files that other agents shared with you');
  files
    .command('get')
    .description(
      'Save a file shared with you into your worktree, checked against its checksum. Never overwrites.',
    )
    .argument('<file-id>', 'File id listed in the message that shared it')
    .requiredOption('--to <path>', 'Where to save it, inside your worktree')
    .option('--agent <id>', 'Your agent id, when this session cannot identify it')
    .action((fileId, options) => {
      // Agents read this output to decide what to do next, so a refusal is one
      // plain line and a non-zero exit, not a stack trace.
      try {
        const { repos } = openContext(process.cwd());
        const saved = fetchSharedFile(repos, {
          fileId,
          agentId: retrievingAgentId(options.agent),
          destination: options.to,
        });
        process.stdout.write(
          `Saved ${saved.filename} (${String(saved.sizeBytes)} bytes, checksum verified) to ${saved.path}\n`,
        );
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    });
}
