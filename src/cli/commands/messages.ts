import type { Command } from '@commander-js/extra-typings';

import type { AgentMessageRecord } from '../../db/index.js';
import { describeReceipt, toReceipt } from '../../domain/receipts.js';
import { openContext } from '../context.js';
import { cloudLinked } from './cloud-inbox.js';

/**
 * The human's view of agent messaging: every message between this
 * workspace's agents, with its receipt. Agents read only their own mail
 * through inspect_work; the person running them may read all of it.
 *
 * Strictly read-only. Looking here never marks anything delivered or read,
 * so a human checking on agents cannot change what their receipts say.
 */

export interface MessagesOptions {
  agent?: string | undefined;
  thread?: string | undefined;
  limit?: number | undefined;
}

const DEFAULT_LIMIT = 50;
const PREVIEW = 80;

export function listMessages(cwd: string, options: MessagesOptions = {}): AgentMessageRecord[] {
  const { repos } = openContext(cwd);
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (options.thread !== undefined) {
    if (repos.agentMessages.get(options.thread) === undefined) {
      throw new Error(`Message ${options.thread} does not exist.`);
    }
    return repos.agentMessages.listThread(options.thread);
  }
  if (options.agent !== undefined)
    return repos.agentMessages.listByAgent(options.agent).slice(-limit);
  return repos.agentMessages.listRecent(limit);
}

function preview(content: string): string {
  const flat = content.replace(/\s+/gu, ' ').trim();
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW - 1)}…` : flat;
}

export function renderMessageLines(messages: readonly AgentMessageRecord[]): string[] {
  if (messages.length === 0) return ['No messages.'];
  return messages.map((message) => {
    const receipt = toReceipt(message);
    const reply = message.replyToMessageId === null ? '' : ` ↩ ${message.replyToMessageId}`;
    return (
      `${message.createdAt}  ${message.senderAgentId} → ${message.recipientAgentId}  ` +
      `[${describeReceipt(receipt)}]  ${message.messageId}${reply}\n    ${preview(message.content)}`
    );
  });
}

export function registerMessagesCommand(program: Command): void {
  program
    .command('messages')
    .description('List messages between agents with their receipts (read-only)')
    .option('--agent <id>', 'Only messages this agent sent or received')
    .option('--thread <id>', 'One prompt/reply thread')
    .option('--limit <n>', 'How many of the newest messages to show', String(DEFAULT_LIMIT))
    .option('--json', 'Print the records with their receipts as JSON')
    .action((options) => {
      if (cloudLinked(process.cwd())) {
        process.stdout.write(
          'This repository is linked to Concord Cloud; see its messages at https://app.getconcord.ai.\n',
        );
        return;
      }
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isFinite(limit) || limit < 1)
        throw new Error('--limit must be a positive number.');
      const messages = listMessages(process.cwd(), {
        agent: options.agent,
        thread: options.thread,
        limit,
      });
      process.stdout.write(
        options.json === true
          ? `${JSON.stringify(messages.map((message) => ({ ...message, receipt: toReceipt(message) })))}\n`
          : `${renderMessageLines(messages).join('\n')}\n`,
      );
    });
}
