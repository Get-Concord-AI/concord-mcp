import { isAbsolute, relative, sep } from 'node:path';

/**
 * Rules for files an agent shares with a prompt or reply. Shared bytes are
 * copied into the store, so these limits bound how far the store can grow.
 */

export const MAX_FILES_PER_MESSAGE = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** A shared file's bytes are removed this long after it was sent. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const FILENAME_LIMIT = 200;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.patch': 'text/x-diff',
  '.diff': 'text/x-diff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

/** The media type a filename's extension implies; unknown types are opaque bytes. */
export function mediaTypeFor(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const extension = dot < 0 ? '' : filename.slice(dot).toLowerCase();
  return MEDIA_TYPES[extension] ?? 'application/octet-stream';
}

/** A filename that prints on one line: control characters become `?`, and it is capped. */
export function displayFilename(name: string): string {
  const printable = name.replace(/\p{Cc}/gu, '?');
  return printable.length > FILENAME_LIMIT ? printable.slice(0, FILENAME_LIMIT) : printable;
}

/** The instant a file sent at `now` stops being retrievable, as an ISO timestamp. */
export function retentionEnd(now: number): string {
  return new Date(now + RETENTION_MS).toISOString();
}

/**
 * Whether `target` is `root` or lies beneath it. Both paths must already be
 * resolved and free of symlinks, so a link cannot make an outside path look inside.
 */
export function isInsideDirectory(root: string, target: string): boolean {
  const offset = relative(root, target);
  if (offset === '') return true;
  return offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

export interface AttachmentReference {
  fileId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Text appended to a message's content listing its files. It lives in the
 * message itself, so every channel that carries the message (live delivery,
 * inbox, inspect_work, the messages listing) shows the same references.
 */
export function attachmentBlock(files: readonly AttachmentReference[]): string {
  const lines = files.map(
    (file) =>
      `- ${file.fileId} ${file.filename} (${file.mediaType}, ${String(file.sizeBytes)} bytes, ` +
      `sha256 ${file.sha256.slice(0, 12)})`,
  );
  return [
    '',
    '',
    'Attached files (retrieve with `concord files get <file-id> --to <path>`):',
    ...lines,
  ].join('\n');
}
