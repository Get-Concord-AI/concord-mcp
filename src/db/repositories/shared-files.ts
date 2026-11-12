import { z } from 'zod';

import type { ConcordDatabase } from '../connection.js';

/** A file to store with a message. Its bytes are written in the same transaction as its row. */
export interface NewSharedFile {
  fileId: string;
  messageId: string;
  senderAgentId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  content: Buffer;
  expiresAt: string;
}

/** A shared file's metadata. Its bytes are read separately, and only for retrieval. */
export interface SharedFileRecord {
  fileId: string;
  messageId: string;
  senderAgentId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  /** When retention removed the bytes; null while they are still retrievable. */
  purgedAt: string | null;
}

export interface StoredSharedFile extends SharedFileRecord {
  content: Buffer | null;
}

export interface SharedFileRepository {
  /** Store files with their message. Replays of a file already stored are ignored. */
  createMany(files: readonly NewSharedFile[]): void;
  /** Remove a message's files, used when the send that they belonged to did not go through. */
  deleteForMessage(messageId: string): void;
  listByMessage(messageId: string): SharedFileRecord[];
  get(fileId: string): StoredSharedFile | undefined;
  /** Remove the bytes of files whose retention has ended; returns how many were removed. */
  purgeExpired(now: string): number;
}

const metaRowSchema = z.object({
  file_id: z.string(),
  message_id: z.string(),
  sender_agent_id: z.string(),
  filename: z.string(),
  media_type: z.string(),
  size_bytes: z.number().int(),
  sha256: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  purged_at: z.string().nullable(),
});
const storedRowSchema = metaRowSchema.extend({ content: z.instanceof(Buffer).nullable() });

type MetaRow = z.infer<typeof metaRowSchema>;

function toRecord(row: MetaRow): SharedFileRecord {
  return {
    fileId: row.file_id,
    messageId: row.message_id,
    senderAgentId: row.sender_agent_id,
    filename: row.filename,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    purgedAt: row.purged_at,
  };
}

const META_COLUMNS = `file_id, message_id, sender_agent_id, filename, media_type,
  size_bytes, sha256, created_at, expires_at, purged_at`;

/**
 * Shared files are keyed by their own ids, which are unique across the store, so
 * they are reached through their message rather than repeating project scoping.
 */
export function createSharedFileRepository(db: ConcordDatabase): SharedFileRepository {
  // OR IGNORE: a retried send derives the same file ids, and the files it first
  // stored already belong to the original message.
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO shared_files (
      file_id, message_id, sender_agent_id, filename, media_type,
      size_bytes, sha256, content, created_at, expires_at
    ) VALUES (
      @file_id, @message_id, @sender_agent_id, @filename, @media_type,
      @size_bytes, @sha256, @content, @created_at, @expires_at
    )
  `);
  const deleteStmt = db.prepare('DELETE FROM shared_files WHERE message_id = ?');
  const listStmt = db.prepare(
    `SELECT ${META_COLUMNS} FROM shared_files WHERE message_id = ? ORDER BY created_at, file_id`,
  );
  const getStmt = db.prepare(`SELECT ${META_COLUMNS}, content FROM shared_files WHERE file_id = ?`);
  const purgeStmt = db.prepare(
    'UPDATE shared_files SET content = NULL, purged_at = ? WHERE purged_at IS NULL AND expires_at <= ?',
  );

  const insertAll = db.transaction((files: readonly NewSharedFile[], createdAt: string) => {
    for (const file of files) {
      insertStmt.run({
        file_id: file.fileId,
        message_id: file.messageId,
        sender_agent_id: file.senderAgentId,
        filename: file.filename,
        media_type: file.mediaType,
        size_bytes: file.sizeBytes,
        sha256: file.sha256,
        content: file.content,
        created_at: createdAt,
        expires_at: file.expiresAt,
      });
    }
  });

  return {
    createMany(files) {
      if (files.length === 0) return;
      insertAll(files, new Date().toISOString());
    },
    deleteForMessage(messageId) {
      deleteStmt.run(messageId);
    },
    listByMessage(messageId) {
      return z
        .array(metaRowSchema)
        .parse(listStmt.all(messageId))
        .map((row) => toRecord(row));
    },
    get(fileId) {
      const raw: unknown = getStmt.get(fileId);
      if (raw === undefined) return undefined;
      const row = storedRowSchema.parse(raw);
      return { ...toRecord(row), content: row.content };
    },
    purgeExpired(now) {
      return purgeStmt.run(now, now).changes;
    },
  };
}
