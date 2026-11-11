import { describe, expect, it } from 'vitest';

import {
  attachmentBlock,
  displayFilename,
  isInsideDirectory,
  mediaTypeFor,
  RETENTION_MS,
  retentionEnd,
} from '../../src/domain/shared-files.js';

describe('shared file rules', () => {
  it('maps extensions to media types, ignoring case, and falls back to opaque bytes', () => {
    expect(mediaTypeFor('run.LOG')).toBe('text/plain');
    expect(mediaTypeFor('shot.png')).toBe('image/png');
    expect(mediaTypeFor('change.patch')).toBe('text/x-diff');
    expect(mediaTypeFor('blob.xyz')).toBe('application/octet-stream');
    expect(mediaTypeFor('README')).toBe('application/octet-stream');
  });

  it('keeps filenames on one line and within a length cap', () => {
    expect(displayFilename('a\nb\tc.txt')).toBe('a?b?c.txt');
    expect(displayFilename('x'.repeat(300))).toHaveLength(200);
  });

  it('counts only paths beneath the root as inside it', () => {
    expect(isInsideDirectory('/work/app', '/work/app')).toBe(true);
    expect(isInsideDirectory('/work/app', '/work/app/src/a.ts')).toBe(true);
    expect(isInsideDirectory('/work/app', '/work/app2/a.ts')).toBe(false);
    expect(isInsideDirectory('/work/app', '/work/other/a.ts')).toBe(false);
    expect(isInsideDirectory('/work/app', '/work')).toBe(false);
  });

  it('ends retention a fixed period after sending', () => {
    const sent = Date.parse('2026-11-11T00:00:00.000Z');
    expect(retentionEnd(sent)).toBe(new Date(sent + RETENTION_MS).toISOString());
  });

  it('lists each file reference in the message text', () => {
    const block = attachmentBlock([
      {
        fileId: 'f_abc',
        filename: 'run.log',
        mediaType: 'text/plain',
        sizeBytes: 6,
        sha256: 'a'.repeat(64),
      },
    ]);

    expect(block).toContain('concord files get <file-id> --to <path>');
    expect(block).toContain('- f_abc run.log (text/plain, 6 bytes, sha256 aaaaaaaaaaaa)');
  });
});
