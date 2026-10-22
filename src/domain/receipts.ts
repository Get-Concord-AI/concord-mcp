import { createHash } from 'node:crypto';

import { z } from 'zod';

import { renderedMessageIds } from './pull-inbox.js';

/**
 * Messaging v2 receipts: what a sender can see about a message it sent, and
 * the rules for when a message counts as read.
 *
 * Read is never inferred from timing. A harness can hold a delivered message
 * for as long as its agent is blocked on the user (an AskUserQuestion picker,
 * a permission prompt), so "a hook fired after delivery" proves nothing. A
 * message is read only when the recipient's own session produces evidence
 * naming its id: the prompt that started a turn, the session transcript, or a
 * Codex turn that completed with it as input.
 */

export type Ticks = '✓' | '✓✓' | 'read' | 'replied' | 'failed';

export interface ReceiptSource {
  messageId: string;
  status: 'sent' | 'delivered' | 'read' | 'replied' | 'failed';
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  repliedAt: string | null;
  failedAt: string | null;
  errorCode: string | null;
  expiresAt: string | null;
}

/** Everything a sender needs to know about how far a message got. */
export interface Receipt {
  message_id: string;
  status: ReceiptSource['status'];
  ticks: Ticks;
  sent_at: string;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  expires_at: string | null;
}

export function ticksFor(status: ReceiptSource['status']): Ticks {
  switch (status) {
    case 'sent':
      return '✓';
    case 'delivered':
      return '✓✓';
    default:
      return status;
  }
}

export function toReceipt(message: ReceiptSource): Receipt {
  return {
    message_id: message.messageId,
    status: message.status,
    ticks: ticksFor(message.status),
    sent_at: message.createdAt,
    delivered_at: message.deliveredAt,
    read_at: message.readAt,
    replied_at: message.repliedAt,
    failed_at: message.failedAt,
    error_code: message.errorCode,
    expires_at: message.expiresAt,
  };
}

/** One line a sender can read at a glance, e.g. `✓✓ delivered 09:00:02Z, not read yet`. */
export function describeReceipt(receipt: Receipt): string {
  switch (receipt.status) {
    case 'sent':
      return `✓ sent ${receipt.sent_at}; not delivered yet (expires ${receipt.expires_at ?? 'never'})`;
    case 'delivered':
      return `✓✓ delivered ${receipt.delivered_at ?? '?'}; not read yet`;
    case 'read':
      return `read ${receipt.read_at ?? '?'}`;
    case 'replied':
      return `replied ${receipt.replied_at ?? '?'}`;
    case 'failed':
      return `failed ${receipt.failed_at ?? '?'} (${receipt.error_code ?? 'unknown'})`;
  }
}

/**
 * The opaque key a harness session is recorded under. Hashed so a raw session
 * id — which some harnesses use as a resume token — is never stored or sent.
 */
export function sessionKey(rawSessionId: string): string {
  return createHash('sha256').update(rawSessionId).digest('hex');
}

/** Ids of Concord messages rendered in a prompt that is starting a turn. */
export function idsInPrompt(prompt: string): string[] {
  return renderedMessageIds(prompt);
}

const roleSchema = z.object({ role: z.string().optional() }).loose();

/** The fields of a transcript entry, in any harness's format, that read evidence needs. */
const transcriptEntrySchema = z
  .object({
    type: z.string().optional(),
    role: z.string().optional(),
    isApiErrorMessage: z.boolean().optional(),
    message: z
      .object({ role: z.string().optional(), model: z.string().optional() })
      .loose()
      .optional()
      .catch(undefined),
    payload: roleSchema.optional().catch(undefined),
  })
  .loose();
type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

/** Gemini records a whole session as one JSON document with a `messages` array. */
const transcriptDocumentSchema = z.object({ messages: z.array(z.json()) }).loose();

/** One entry, with the text it was read from so message headers can be found in it. */
interface ParsedEntry {
  entry: TranscriptEntry;
  text: string;
}

/**
 * An assistant entry the harness wrote itself rather than the model: Claude
 * Code records API errors and interrupted turns as `<synthetic>` assistant
 * messages. Those prove nothing about what the model was sent.
 */
function isSyntheticEntry(entry: TranscriptEntry): boolean {
  return entry.isApiErrorMessage === true || entry.message?.model === '<synthetic>';
}

/** A transcript entry the model wrote, in any harness's format. */
function isModelEntry(entry: TranscriptEntry): boolean {
  if (isSyntheticEntry(entry)) return false;
  const { type } = entry;
  // Claude Code and Grok (`assistant`), Gemini (`gemini`), Copilot CLI (`assistant.message`).
  if (
    type === 'assistant' ||
    type === 'gemini' ||
    type === 'model' ||
    type === 'assistant.message'
  ) {
    return true;
  }
  return [entry.role, entry.message?.role, entry.payload?.role].some(
    (role) => role === 'assistant' || role === 'model',
  );
}

/**
 * An entry that only queues text for later (Claude Code writes a held monitor
 * notification as `queue-operation` before the model is ever shown it).
 */
function isQueuedOnly(entry: TranscriptEntry): boolean {
  return entry.type === 'queue-operation';
}

function parseEntry(text: string): ParsedEntry | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    const parsed = transcriptEntrySchema.safeParse(raw);
    return parsed.success ? { entry: parsed.data, text } : undefined;
  } catch {
    return undefined;
  }
}

function transcriptEntries(text: string): ParsedEntry[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
    try {
      const raw: unknown = JSON.parse(trimmed);
      const document = transcriptDocumentSchema.safeParse(raw);
      if (document.success) {
        return document.data.messages.flatMap((message) => {
          const entry = parseEntry(JSON.stringify(message));
          return entry === undefined ? [] : [entry];
        });
      }
    } catch {
      // Fall through to JSONL.
    }
  }
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return [];
    const entry = parseEntry(line);
    return entry === undefined ? [] : [entry];
  });
}

/**
 * Which of `candidates` a session transcript proves the model read: the
 * message header appears in an entry that is part of the conversation (not
 * merely queued), and the model wrote something after it.
 */
export function idsReadInTranscript(text: string, candidates: readonly string[]): string[] {
  return scanTranscript(text, candidates).read;
}

/**
 * Like `idsReadInTranscript`, but also which candidates the transcript shows
 * with nothing from the model after them yet: a harness that writes its log a
 * moment late can be read again for those.
 */
export function scanTranscript(
  text: string,
  candidates: readonly string[],
): { read: string[]; pending: string[] } {
  if (candidates.length === 0) return { read: [], pending: [] };
  const wanted = new Set(candidates);
  const shown = new Set<string>();
  const read = new Set<string>();
  for (const { entry, text: entryText } of transcriptEntries(text)) {
    if (isModelEntry(entry)) {
      for (const id of shown) read.add(id);
      shown.clear();
      continue;
    }
    if (isQueuedOnly(entry)) continue;
    for (const id of renderedMessageIds(entryText)) {
      if (wanted.has(id) && !read.has(id)) shown.add(id);
    }
  }
  return { read: [...read], pending: [...shown] };
}
