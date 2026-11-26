/** Markers delimiting Concord's managed block within a client instruction file. */
export const BLOCK_START = '<!-- concord:start -->';
export const BLOCK_END = '<!-- concord:end -->';

const defaultMarkers = { start: BLOCK_START, end: BLOCK_END };

/**
 * Insert or replace Concord's managed block in `existing`, preserving all other
 * content. Idempotent: running it again with the same block is a no-op.
 */
export function upsertBlock(existing: string, block: string, markers = defaultMarkers): string {
  const wrapped = `${markers.start}\n${block}\n${markers.end}`;

  const startIdx = existing.indexOf(markers.start);
  const endIdx = existing.indexOf(markers.end);
  if (startIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + markers.end.length);
    return `${before}${wrapped}${after}`;
  }

  if (existing.length === 0) {
    return `${wrapped}\n`;
  }
  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${wrapped}\n`;
}

/**
 * Remove Concord's block and only the separators `upsertBlock` added; the rest
 * stays byte for byte, except that a file without a final newline gets one, as
 * `upsertBlock` gives `abc` and `abc\n` the same output.
 */
export function removeBlock(existing: string, markers = defaultMarkers): string {
  const startIdx = existing.indexOf(markers.start);
  const endIdx = existing.indexOf(markers.end);
  if (startIdx === -1 || endIdx < startIdx) return existing;
  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + markers.end.length);
  return (
    (before.endsWith('\n\n') ? before.slice(0, -1) : before) +
    (after.startsWith('\n') ? after.slice(1) : after)
  );
}
