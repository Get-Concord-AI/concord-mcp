import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  before,
  CloudApiError,
  agentCachePath,
  readAgentState,
  reportDeliveryFailure,
  type CloudRuntime,
} from '../../cloud/runtime.js';
import { renderInboxBody, type DeliverableMessage } from '../../domain/pull-inbox.js';
import { CodexAppServerAdapter } from '../../relay/adapters.js';
import { CodexDaemonClient } from '../../relay/codex-client.js';
import { RELAY_PROTOCOL_VERSION } from '../../relay/protocol.js';
import type { AgentSessionAdapter, AgentSessionDelivery } from '../../relay/server.js';
import { watchCloud } from './cloud-inbox.js';

/**
 * Codex, live, in a repository linked to Concord Cloud. The cloud cannot dial
 * this machine, so the local host that already steers Codex through its
 * app-server pulls instead: it holds the session's receiver and long-polls the
 * cloud, and hands each message to Codex as it arrives — steering a turn under
 * way, or starting one when Codex is idle — as the local relay does.
 */

/** How often saved failure reports are tried again while the host runs. */
const REPORT_RETRY_MS = 60_000;

interface Undelivered {
  readonly messageId: string;
  readonly detail: string;
}

const undeliveredSchema = z.object({ messageId: z.string(), detail: z.string() });

/** One file per report not yet made, so hosts never rewrite each other's. */
function unreportedDir(runtime: CloudRuntime, agentKey: string): string {
  return agentCachePath(runtime.repoRoot, agentKey).replace(/\.json$/, '.unreported');
}

function savedReports(dir: string): (Undelivered & { readonly file: string })[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const parsed = undeliveredSchema.safeParse(raw);
      return parsed.success ? [{ ...parsed.data, file: join(dir, name) }] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Tells the cloud these messages were not delivered, so their senders do not
 * take silence for delivery. The batch was drained, so a report that cannot be
 * made now is saved and made on a later round, with any saved before.
 */
async function reportUndelivered(
  runtime: CloudRuntime,
  agentKey: string,
  failures: readonly Undelivered[],
): Promise<void> {
  const state = readAgentState(runtime, agentKey);
  if (state === undefined) return;
  const dir = unreportedDir(runtime, agentKey);
  const pending = [
    ...savedReports(dir),
    ...failures.map((failure) => ({ ...failure, file: undefined })),
  ];
  for (const failure of pending) {
    let keep = false;
    try {
      await reportDeliveryFailure(runtime, state, failure.messageId, failure.detail);
    } catch (error) {
      // Refused for good (the message moved on): nothing a retry would change.
      keep = !(error instanceof CloudApiError && error.status < 500 && error.status !== 429);
    }
    if (keep && failure.file === undefined) {
      mkdirSync(dir, { recursive: true });
      const file = join(
        dir,
        `${createHash('sha256').update(failure.messageId).digest('hex').slice(0, 16)}.json`,
      );
      writeFileSync(file, JSON.stringify({ messageId: failure.messageId, detail: failure.detail }));
    } else if (!keep && failure.file !== undefined) {
      rmSync(failure.file, { force: true });
    }
  }
}

/**
 * Hands drained messages to the session, one at a time and never two at once.
 * A handoff has no time limit: a wedged session stalls the host, which then
 * drains nothing more and lets its receiver lease lapse, so later messages
 * wait for the session's hooks instead. Stopping the host ends a handoff in
 * progress and hands over nothing more. Every message not handed over — or
 * whose handoff ended unconfirmed — is reported as not delivered.
 */
export async function deliverToSession(
  runtime: CloudRuntime,
  agentKey: string,
  adapter: AgentSessionAdapter,
  messages: readonly DeliverableMessage[],
  stop?: AbortSignal,
): Promise<void> {
  const failures: Undelivered[] = [];
  const stopped = (): boolean => stop?.aborted === true;
  for (const message of messages) {
    if (stopped()) {
      failures.push({
        messageId: message.messageId,
        detail: 'The Codex host stopped before handing it over.',
      });
      continue;
    }
    const delivery: AgentSessionDelivery = {
      version: RELAY_PROTOCOL_VERSION,
      type: 'deliver',
      messageId: message.messageId,
      senderAgentId: message.senderAgentId,
      recipientAgentId: agentKey,
      // Framed as every other channel frames it, so the session knows who
      // wrote and which id to answer.
      content: renderInboxBody([message]),
    };
    const handoff = adapter.isBusy() ? adapter.steer(delivery) : adapter.inject(delivery);
    try {
      await (stop === undefined ? handoff : before(handoff, stop));
    } catch (error) {
      const detail = stopped()
        ? 'The Codex host stopped before Codex confirmed it; it may not have arrived.'
        : error instanceof Error
          ? error.message
          : String(error);
      process.stderr.write(`Concord: could not hand ${message.messageId} to Codex: ${detail}\n`);
      failures.push({ messageId: message.messageId, detail });
    }
  }
  await reportUndelivered(runtime, agentKey, failures);
}

/** Hosts one Codex thread's live receiver against the cloud, until stopped. */
export async function hostCodexInCloud(
  runtime: CloudRuntime,
  agentKey: string,
  threadId: string,
): Promise<void> {
  const client = new CodexDaemonClient();
  await client.connect();
  await client.resumeThread(threadId);
  const adapter = new CodexAppServerAdapter(client, threadId, () => client.currentTurnId());
  // Reports saved while the cloud was unreachable are made now and every
  // minute, not only when the next message happens to arrive.
  const flush = (): void => {
    void reportUndelivered(runtime, agentKey, []).catch(() => undefined);
  };
  flush();
  const retrying = setInterval(flush, REPORT_RETRY_MS);
  retrying.unref();
  try {
    await watchCloud(runtime, agentKey, 'codex', false, (messages, stop) =>
      deliverToSession(runtime, agentKey, adapter, messages, stop),
    );
  } finally {
    clearInterval(retrying);
    client.close();
  }
}
