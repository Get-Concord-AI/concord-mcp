import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { userHome } from '../../config/paths.js';
import type { DeliverableMessage } from '../../domain/pull-inbox.js';

/**
 * Messages a Copilot hook drained but could not show yet.
 *
 * A drain marks every message it takes as delivered, while Copilot caps a tool
 * hook's context at 10 KB. Rather than cut a message short, the hook shows the
 * whole messages that fit and keeps the rest here; the session's next hook
 * shows them first, and its stop hook — which has no cap — shows everything.
 * Only a session's hooks use its file, and they run one at a time.
 */
export interface MessageSpool {
  take(agentId: string): DeliverableMessage[];
  put(agentId: string, messages: readonly DeliverableMessage[]): void;
}

const spooledSchema = z.array(
  z.object({
    messageId: z.string(),
    senderAgentId: z.string(),
    taskId: z.string().nullable(),
    content: z.string(),
    messageKind: z.enum(['prompt', 'reply']),
    deliveryLatencyMs: z.number().nullable(),
  }),
);

/**
 * The spool under `~/.concord/copilot-spool`, one file per agent per
 * repository: an operator-chosen id such as `alpha` may run in several.
 */
export function fileSpool(repoRoot: string, env: NodeJS.ProcessEnv = process.env): MessageSpool {
  const dir = join(userHome(env), '.concord', 'copilot-spool');
  const pathFor = (agentId: string): string =>
    join(
      dir,
      `${createHash('sha256').update(`${repoRoot}\0${agentId}`).digest('hex').slice(0, 16)}.json`,
    );
  return {
    take: (agentId) => {
      const path = pathFor(agentId);
      if (!existsSync(path)) return [];
      try {
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
        return spooledSchema.parse(raw);
      } catch {
        return [];
      } finally {
        rmSync(path, { force: true });
      }
    },
    put: (agentId, messages) => {
      if (messages.length === 0) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(pathFor(agentId), JSON.stringify(messages), { mode: 0o600 });
    },
  };
}
