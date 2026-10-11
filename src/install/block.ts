/** Markers delimiting Concord's managed block within a client instruction file. */
export const BLOCK_START = '<!-- concord:start -->';
export const BLOCK_END = '<!-- concord:end -->';

/**
 * Insert or replace Concord's managed block in `existing`, preserving all other
 * content. Idempotent: running it again with the same block is a no-op.
 */
export function upsertBlock(existing: string, block: string): string {
  const wrapped = `${BLOCK_START}\n${block}\n${BLOCK_END}`;

  const startIdx = existing.indexOf(BLOCK_START);
  const endIdx = existing.indexOf(BLOCK_END);
  if (startIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + BLOCK_END.length);
    return `${before}${wrapped}${after}`;
  }

  if (existing.length === 0) {
    return `${wrapped}\n`;
  }
  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${wrapped}\n`;
}

/** Remove Concord's managed block from `existing`, leaving everything else. */
export function removeBlock(existing: string): string {
  const startIdx = existing.indexOf(BLOCK_START);
  const endIdx = existing.indexOf(BLOCK_END);
  if (startIdx === -1 || endIdx < startIdx) return existing;
  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + BLOCK_END.length).trim();
  const kept = [before, after].filter((part) => part !== '').join('\n\n');
  return kept === '' ? '' : `${kept}\n`;
}
