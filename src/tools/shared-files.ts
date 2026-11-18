import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { CONCORD_DIR, findCheckoutRoot, findRepoRoot } from '../config/paths.js';
import type { Repositories } from '../db/index.js';
import {
  attachmentBlock,
  type AttachmentReference,
  displayFilename,
  isInsideDirectory,
  MAX_FILE_BYTES,
  MAX_FILES_PER_MESSAGE,
  MAX_TOTAL_BYTES,
  mediaTypeFor,
  retentionEnd,
} from '../domain/shared-files.js';
import {
  deliverAcceptedMessage,
  handleSendAgentMessage,
  handleSendAgentMessageWithDelivery,
  type AgentMessageDispatcher,
  type SendAgentMessageInput,
  type SendAgentMessageResult,
} from './agent-messages.js';

/**
 * Files an agent shares with a prompt or reply. Each file is read from the
 * sender's own worktree, checked, and stored with its message in the same
 * transaction. Retrieval by the recipient is not implemented yet.
 */

/** A file read from the sender's worktree, not yet stored with its message. */
export interface StagedFile extends AttachmentReference {
  content: Buffer;
}

export function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * A file id that a retry of the same send reproduces exactly, so the retry
 * finds the files it already stored instead of storing them again.
 */
function fileIdFor(
  senderAgentId: string,
  idempotencyKey: string,
  index: number,
  sha256: string,
): string {
  const digest = createHash('sha256')
    .update([senderAgentId, idempotencyKey, String(index), sha256].join('\n'))
    .digest('hex');
  return `f_${digest.slice(0, 24)}`;
}

/**
 * The checkout an agent's relative paths resolve against. The worktree it
 * registered is free-form text, so it is trusted only if it sits in a checkout
 * of this workspace's repository.
 */
function realWorktree(repos: Repositories, agentId: string, workspaceRoot: string): string {
  const agent = repos.agents.get(agentId);
  if (agent === undefined) throw new Error(`Agent ${agentId} is not registered.`);
  const registered = agent.worktree ?? agent.cwd;
  if (registered === null || registered === '') {
    throw new Error(
      `Agent ${agentId} registered no worktree; call start_work with its worktree before sharing files.`,
    );
  }
  if (!existsSync(registered))
    throw new Error(`Worktree ${registered} for ${agentId} does not exist.`);
  // Use the checkout the path is in, not the path itself. A registered "/Users/me",
  // or a folder inside .git, is not a checkout of this repo, so it cannot be the boundary.
  const checkout = findCheckoutRoot(realpathSync(registered));
  if (findRepoRoot(checkout) !== workspaceRoot) {
    throw new Error(
      `Worktree ${registered} for ${agentId} is not a checkout of this repository, so files cannot be shared from it.`,
    );
  }
  return checkout;
}

/** Concord's own folder and git's folder: file sharing never reads from or writes into them. */
function isReserved(root: string, real: string): boolean {
  return [CONCORD_DIR, '.git'].some((reserved) => isInsideDirectory(join(root, reserved), real));
}

/** A path the sender named, resolved past symlinks, if it is inside its worktree and not Concord or git state. */
function sharedSource(root: string, path: string): string {
  const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (!existsSync(candidate)) throw new Error(`${path} does not exist.`);
  const real = realpathSync(candidate);
  if (!isInsideDirectory(root, real)) {
    throw new Error(`${path} is outside your worktree; only files in your worktree can be shared.`);
  }
  if (isReserved(root, real)) {
    throw new Error(`${path} is Concord or git metadata and cannot be shared.`);
  }
  return real;
}

/**
 * Read at most `limit + 1` bytes. The extra byte shows a caller that a file is
 * over the limit, even one that grew after it was measured, without loading all
 * of it into memory.
 */
export function readAtMost(path: string, limit: number): Buffer {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const count = readSync(descriptor, buffer, filled, buffer.length - filled, filled);
      if (count === 0) break;
      filled += count;
    }
    return Buffer.from(buffer.subarray(0, filled));
  } finally {
    closeSync(descriptor);
  }
}

/** Check and read every file a message names, before anything is sent. */
export function stageAttachments(
  repos: Repositories,
  senderAgentId: string,
  paths: readonly string[],
  idempotencyKey: string,
  workspaceRoot: string,
): StagedFile[] {
  if (paths.length > MAX_FILES_PER_MESSAGE) {
    throw new Error(`A message can share at most ${String(MAX_FILES_PER_MESSAGE)} files.`);
  }
  const root = realWorktree(repos, senderAgentId, workspaceRoot);
  let total = 0;
  return paths.map((path, index) => {
    const source = sharedSource(root, path);
    if (!statSync(source).isFile()) throw new Error(`${path} is not a regular file.`);
    // Measured by what is actually read, not by an earlier stat: the file may grow in between.
    const content = readAtMost(source, MAX_FILE_BYTES);
    if (content.length > MAX_FILE_BYTES) {
      throw new Error(`${path} is larger than the ${String(MAX_FILE_BYTES)}-byte limit per file.`);
    }
    total += content.length;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`These files total more than ${String(MAX_TOTAL_BYTES)} bytes.`);
    }
    const sha256 = sha256Hex(content);
    const filename = displayFilename(basename(path));
    return {
      fileId: fileIdFor(senderAgentId, idempotencyKey, index, sha256),
      filename,
      mediaType: mediaTypeFor(filename),
      sizeBytes: content.length,
      sha256,
      content,
    };
  });
}

export interface SendWithFilesInput extends SendAgentMessageInput {
  attachments?: readonly string[] | undefined;
  /** The repository root of this workspace. Files can be shared only when it is known. */
  workspaceRoot?: string | undefined;
}

/**
 * Send a prompt or reply, with the files it names. The message and its files
 * are stored in one transaction, so a retry finds both or neither, and no file
 * is ever left pointing at a message that does not exist. Delivery happens after
 * the commit, so a recipient is never told about a file that is not stored yet.
 */
export async function handleSendWithAttachments(
  repos: Repositories,
  input: SendWithFilesInput,
  dispatcher: AgentMessageDispatcher,
): Promise<SendAgentMessageResult> {
  const { attachments, workspaceRoot, ...send } = input;
  if (attachments === undefined || attachments.length === 0) {
    return handleSendAgentMessageWithDelivery(repos, send, dispatcher);
  }
  if (workspaceRoot === undefined) {
    throw new Error('Files cannot be shared here: this server does not know its workspace root.');
  }
  repos.sharedFiles.purgeExpired(new Date().toISOString());
  const staged = stageAttachments(
    repos,
    send.agentId,
    attachments,
    send.idempotencyKey,
    workspaceRoot,
  );
  const messageId = randomUUID();
  const expiresAt = retentionEnd(Date.now());

  // `immediate` takes the write lock before reading, so two processes sending
  // with the same key serialize, and the second one replays the first.
  const accepted = repos.db
    .transaction(() => {
      const result = handleSendAgentMessage(repos, {
        ...send,
        messageId,
        content: send.content + attachmentBlock(staged),
      });
      if (!result.idempotentReplay) {
        repos.sharedFiles.createMany(
          staged.map((file) => ({ ...file, messageId, senderAgentId: send.agentId, expiresAt })),
        );
      }
      return result;
    })
    .immediate();

  let result: SendAgentMessageResult;
  try {
    result = await deliverAcceptedMessage(repos, accepted, dispatcher);
  } catch (error) {
    // Delivery failed after the commit, so the message is marked failed and its files go too.
    if (!accepted.idempotentReplay) repos.sharedFiles.deleteForMessage(messageId);
    throw error;
  }

  const attached = repos.sharedFiles.listByMessage(result.message.messageId);
  const ids = attached.map((file) => file.fileId).join(', ');
  return {
    ...result,
    outlook: `${result.outlook} Attached ${String(attached.length)} file(s): ${ids}.`,
  };
}
