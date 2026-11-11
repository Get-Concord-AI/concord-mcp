import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { CONCORD_DIR } from '../config/paths.js';
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
  handleSendAgentMessageWithDelivery,
  type AgentMessageDispatcher,
  type SendAgentMessageInput,
  type SendAgentMessageResult,
} from './agent-messages.js';

/**
 * Files an agent shares with a prompt or reply. Each file is read from the
 * sender's own worktree, copied into the store with its message, and retrieved
 * by a recipient through `concord files get`, which checks the checksum and
 * writes only inside the recipient's worktree. Nothing else on either machine
 * is reachable through these paths.
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
 * The worktree an agent's relative paths resolve against: the one it
 * registered, with symlinks resolved. Agents with no registered worktree
 * cannot share files, since there is nothing to bound their access.
 */
function realWorktree(repos: Repositories, agentId: string): string {
  const agent = repos.agents.get(agentId);
  if (agent === undefined) throw new Error(`Agent ${agentId} is not registered.`);
  const root = agent.worktree ?? agent.cwd;
  if (root === null || root === '') {
    throw new Error(
      `Agent ${agentId} registered no worktree; call start_work with its worktree before sharing files.`,
    );
  }
  if (!existsSync(root)) throw new Error(`Worktree ${root} for ${agentId} does not exist.`);
  return realpathSync(root);
}

/** A path the sender named, resolved past symlinks, if it is inside its worktree and not Concord or git state. */
function sharedSource(root: string, path: string): string {
  const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (!existsSync(candidate)) throw new Error(`${path} does not exist.`);
  const real = realpathSync(candidate);
  if (!isInsideDirectory(root, real)) {
    throw new Error(`${path} is outside your worktree; only files in your worktree can be shared.`);
  }
  for (const reserved of [CONCORD_DIR, '.git']) {
    if (isInsideDirectory(join(root, reserved), real)) {
      throw new Error(`${path} is Concord or git metadata and cannot be shared.`);
    }
  }
  return real;
}

/** Check and read every file a message names, before anything is sent. */
export function stageAttachments(
  repos: Repositories,
  senderAgentId: string,
  paths: readonly string[],
  idempotencyKey: string,
): StagedFile[] {
  if (paths.length > MAX_FILES_PER_MESSAGE) {
    throw new Error(`A message can share at most ${String(MAX_FILES_PER_MESSAGE)} files.`);
  }
  const root = realWorktree(repos, senderAgentId);
  let total = 0;
  return paths.map((path, index) => {
    const source = sharedSource(root, path);
    const info = statSync(source);
    if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(
        `${path} is ${String(info.size)} bytes; the limit is ${String(MAX_FILE_BYTES)} bytes per file.`,
      );
    }
    total += info.size;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`These files total more than ${String(MAX_TOTAL_BYTES)} bytes.`);
    }
    const content = readFileSync(source);
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
}

/**
 * Send a prompt or reply, with the files it names. Files are checked and read
 * first, then stored before the message is delivered, so a recipient can never
 * be told about a file that is not there yet. A send that does not go through
 * leaves none of its files behind.
 */
export async function handleSendWithAttachments(
  repos: Repositories,
  input: SendWithFilesInput,
  dispatcher: AgentMessageDispatcher,
): Promise<SendAgentMessageResult> {
  const { attachments, ...send } = input;
  if (attachments === undefined || attachments.length === 0) {
    return handleSendAgentMessageWithDelivery(repos, send, dispatcher);
  }
  repos.sharedFiles.purgeExpired(new Date().toISOString());
  const staged = stageAttachments(repos, send.agentId, attachments, send.idempotencyKey);
  const messageId = randomUUID();
  const expiresAt = retentionEnd(Date.now());
  repos.sharedFiles.createMany(
    staged.map((file) => ({ ...file, messageId, senderAgentId: send.agentId, expiresAt })),
  );

  let result: SendAgentMessageResult;
  try {
    result = await handleSendAgentMessageWithDelivery(
      repos,
      { ...send, messageId, content: send.content + attachmentBlock(staged) },
      dispatcher,
    );
  } catch (error) {
    repos.sharedFiles.deleteForMessage(messageId);
    throw error;
  }
  if (result.idempotentReplay) repos.sharedFiles.deleteForMessage(messageId);

  const attached = repos.sharedFiles.listByMessage(result.message.messageId);
  const ids = attached.map((file) => file.fileId).join(', ');
  return {
    ...result,
    outlook: `${result.outlook} Attached ${String(attached.length)} file(s): ${ids}.`,
  };
}

export interface FetchSharedFileInput {
  fileId: string;
  agentId: string;
  /** Where to save it: relative to the reader's worktree, or an absolute path inside it. */
  destination: string;
}

export interface FetchedSharedFile {
  fileId: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  senderAgentId: string;
  path: string;
}

/**
 * The path a retrieved file may be written to: inside the reader's worktree,
 * with the nearest existing folder resolved past symlinks so a link cannot
 * lead the write out of it. Creating folders is allowed; overwriting is not.
 */
function writeInside(root: string, requested: string, content: Buffer): string {
  const target = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  let ancestor = dirname(target);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const real = join(realpathSync(ancestor), relative(ancestor, target));
  if (!isInsideDirectory(root, real)) {
    throw new Error(`${requested} is outside your worktree; retrieved files are saved inside it.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(target, content, { flag: 'wx' });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `${requested} already exists; choose another --to path so nothing is overwritten.`,
        { cause: error },
      );
    }
    throw error;
  }
  return target;
}

/**
 * Save a shared file into the reader's worktree. Only the sender and recipient
 * of its message may read it, and anyone else is told it does not exist. The
 * bytes are checked against their checksum before anything is written.
 */
export function fetchSharedFile(
  repos: Repositories,
  input: FetchSharedFileInput,
  now: number = Date.now(),
): FetchedSharedFile {
  repos.sharedFiles.purgeExpired(new Date(now).toISOString());
  const file = repos.sharedFiles.get(input.fileId);
  const message = file === undefined ? undefined : repos.agentMessages.get(file.messageId);
  const reader =
    message !== undefined &&
    (message.senderAgentId === input.agentId || message.recipientAgentId === input.agentId);
  if (file === undefined || !reader) {
    throw new Error(`No shared file ${input.fileId} is available to ${input.agentId}.`);
  }
  if (file.content === null) {
    throw new Error(
      `${file.filename} was removed on ${file.purgedAt ?? file.expiresAt}, when its retention ended. ` +
        'Ask the sender to share it again.',
    );
  }
  if (sha256Hex(file.content) !== file.sha256) {
    throw new Error(
      `${file.filename} failed its checksum, so nothing was saved. Ask the sender to share it again.`,
    );
  }
  const root = realWorktree(repos, input.agentId);
  const path = writeInside(root, input.destination, file.content);
  return {
    fileId: file.fileId,
    filename: file.filename,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    senderAgentId: file.senderAgentId,
    path,
  };
}
