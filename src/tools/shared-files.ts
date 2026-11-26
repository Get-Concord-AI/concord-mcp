import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

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
  AgentMessageDeliveryError,
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
 * The checkout that bounds an agent's files, and the folder it registered, which
 * its relative paths resolve from. The registered path is free-form text, so it
 * is trusted only if it sits in a checkout of this workspace's repository.
 */
function realWorktree(
  repos: Repositories,
  agentId: string,
  workspaceRoot: string,
): { checkout: string; cwd: string } {
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
  const checkout = findCheckoutRoot(realpathSync.native(registered));
  if (
    !samePath(findRepoRoot(checkout), workspaceRoot) ||
    !isRegisteredWorktree(workspaceRoot, checkout)
  ) {
    throw new Error(
      `Worktree ${registered} for ${agentId} is not a checkout of this repository, so files cannot be shared from it.`,
    );
  }
  return { checkout, cwd: realpathSync.native(registered) };
}

/** Concord's own folder and git's folder: file sharing never reads from or writes into them. */
/**
 * Concord's own folder and git's folder, matched by name whatever the case: APFS and
 * NTFS treat `.GIT` as `.git`, so a case-sensitive check lets `.GIT/config` through.
 * Matching every case is stricter than Linux needs, which is the safe side here.
 */
function isReserved(root: string, real: string): boolean {
  const first = relative(root, real).split(sep)[0]?.toLowerCase();
  return first === CONCORD_DIR.toLowerCase() || first === '.git';
}

/**
 * A path in the form two paths are compared by: the native realpath, which expands
 * 8.3 short names such as RUNNER~1, and case-folded on Windows.
 */
function canonical(path: string): string {
  const real = realpathSync.native(path);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

/**
 * Whether git itself lists `checkout` as a worktree of `repoRoot`. A `.git` file that
 * points at this repository's metadata is not enough: git has to know the checkout.
 */
function isRegisteredWorktree(repoRoot: string, checkout: string): boolean {
  let listing: string;
  try {
    // -z ends every line with NUL, so a path with a newline or a trailing space stays whole.
    listing = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8',
    });
  } catch {
    return false;
  }
  return listing.split('\0').some((line) => {
    if (!line.startsWith('worktree ')) return false;
    const listed = line.slice('worktree '.length);
    return existsSync(listed) && samePath(listed, checkout);
  });
}

/** The checks every shared file must pass: inside the checkout, and not Concord or git state. */
function assertShareable(checkout: string, real: string, path: string): void {
  if (!isInsideDirectory(checkout, real)) {
    throw new Error(`${path} is outside your worktree; only files in your worktree can be shared.`);
  }
  if (isReserved(checkout, real)) {
    throw new Error(`${path} is Concord or git metadata and cannot be shared.`);
  }
}

/**
 * A path the sender named, resolved past symlinks. A relative path is read from the
 * folder the agent registered, and the result must be inside its checkout and not
 * Concord or git state.
 */
function sharedSource(checkout: string, base: string, path: string): string {
  const candidate = isAbsolute(path) ? resolve(path) : resolve(base, path);
  if (!existsSync(candidate)) throw new Error(`${path} does not exist.`);
  const real = realpathSync.native(candidate);
  assertShareable(checkout, real, path);
  return real;
}

/** Where an open descriptor's file really is, where the platform reports it (Linux). */
function descriptorPath(descriptor: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return realpathSync(`/proc/self/fd/${String(descriptor)}`);
  } catch {
    return undefined;
  }
}

/**
 * Read at most `limit + 1` bytes from a file the sender named. The checks apply to the
 * file that was opened. On Linux they apply to where the open descriptor really is, so
 * a folder swapped during the open is seen. Elsewhere, the path is resolved and checked,
 * and the open file must be the file the path points to. Either way the file must be
 * inside the checkout and not Concord or git state. The extra byte shows a caller that a
 * file is over the limit without loading all of it.
 */
export function readAtMost(path: string, limit: number, checkout: string): Buffer {
  // Refuse a final symlink where the platform supports O_NOFOLLOW (not Windows).
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    const where = descriptorPath(descriptor) ?? realpathSync.native(path);
    assertShareable(checkout, where, path);
    const current = statSync(where);
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error(`${path} changed while it was being read; nothing was shared from it.`);
    }
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
  const { checkout, cwd } = realWorktree(repos, senderAgentId, workspaceRoot);
  let total = 0;
  return paths.map((path, index) => {
    const source = sharedSource(checkout, cwd, path);
    if (!statSync(source).isFile()) throw new Error(`${path} is not a regular file.`);
    // Measured by what is actually read, not by an earlier stat: the file may grow in between.
    const content = readAtMost(source, MAX_FILE_BYTES, checkout);
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

/**
 * The files a retry gets back, as stored with the first send. The retry must name the
 * same files, by name and in the same order, or it is a different message.
 */
function storedReferences(
  repos: Repositories,
  messageId: string,
  attachments: readonly string[],
): AttachmentReference[] {
  const stored = repos.sharedFiles.listByMessage(messageId);
  const named = attachments.map((path) => displayFilename(basename(path)));
  const same =
    stored.length === named.length && stored.every((file, index) => file.filename === named[index]);
  if (!same) {
    throw new AgentMessageDeliveryError(
      'unauthorized',
      messageId,
      'idempotency_key was already used for a different message.',
    );
  }
  return stored;
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
  // A retry of a send that already went through is answered from what was stored. Its
  // source files are not read again, since they may have been deleted or changed.
  const earlier = repos.agentMessages.getByIdempotency(send.agentId, send.idempotencyKey);
  let fresh: StagedFile[] | undefined;
  let references: readonly AttachmentReference[];
  if (earlier === undefined) {
    fresh = stageAttachments(repos, send.agentId, attachments, send.idempotencyKey, workspaceRoot);
    references = fresh;
  } else {
    references = storedReferences(repos, earlier.messageId, attachments);
  }
  const messageId = randomUUID();
  const expiresAt = retentionEnd(Date.now());

  // `immediate` takes the write lock before reading, so two processes sending
  // with the same key serialize, and the second one replays the first.
  const accepted = repos.db
    .transaction(() => {
      const result = handleSendAgentMessage(repos, {
        ...send,
        messageId,
        content: send.content + attachmentBlock(references),
      });
      if (!result.idempotentReplay && fresh !== undefined) {
        repos.sharedFiles.createMany(
          fresh.map((file) => ({ ...file, messageId, senderAgentId: send.agentId, expiresAt })),
        );
      }
      return result;
    })
    .immediate();

  let result: SendAgentMessageResult;
  try {
    result = await deliverAcceptedMessage(repos, accepted, dispatcher);
  } catch (error) {
    // Delivery failed after the commit. The files go only if the message is now failed:
    // a message the recipient already read still refers to them, so they stay.
    if (!accepted.idempotentReplay) repos.sharedFiles.deleteForFailedMessage(messageId);
    throw error;
  }

  const attached = repos.sharedFiles.listByMessage(result.message.messageId);
  const ids = attached.map((file) => file.fileId).join(', ');
  return {
    ...result,
    outlook: `${result.outlook} Attached ${String(attached.length)} file(s): ${ids}.`,
  };
}
