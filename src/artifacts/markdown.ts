/** Small shared helpers for rendering markdown artifacts. */

const EMPTY = '_None_';

/** Render items as a markdown bullet list, or a placeholder when empty. */
export function bulletList(items: readonly string[]): string {
  if (items.length === 0) {
    return EMPTY;
  }
  return items.map((item) => `- ${item}`).join('\n');
}

/** Render items as a markdown bullet list with each item in inline code. */
export function codeBulletList(items: readonly string[]): string {
  if (items.length === 0) {
    return EMPTY;
  }
  return items.map((item) => `- \`${item}\``).join('\n');
}
