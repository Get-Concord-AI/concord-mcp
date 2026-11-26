import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { isRootClaim, normalizePath } from '../domain/overlap.js';

/** Follow symlinks in an absolute path, including for files yet to be created. */
function resolveExistingParents(path: string): string {
  let ancestor = path;
  for (;;) {
    try {
      return join(realpathSync(ancestor), relative(ancestor, path));
    } catch (error) {
      const parent = dirname(ancestor);
      if (
        parent === ancestor ||
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        return path;
      }
      ancestor = parent;
    }
  }
}

/**
 * A declared or edited file as the checkout names it, so the same file
 * compares equal however it is written: an absolute path inside the checkout
 * becomes checkout-relative, and a path through a symlink names the file it
 * points at, including a file that does not exist yet. Root claims, paths
 * outside the checkout, and everything without a known checkout are returned
 * as given.
 */
export function pathFromCheckout(checkoutRoot: string | undefined, path: string): string {
  if (checkoutRoot === undefined || isRootClaim(path)) return path;
  const root = resolveExistingParents(checkoutRoot);
  const absolute = isAbsolute(path) ? path : join(checkoutRoot, path);
  const within = relative(root, resolveExistingParents(absolute)).replaceAll('\\', '/');
  if (within === '' || within === '..' || within.startsWith('../') || isAbsolute(within)) {
    return path;
  }
  return within;
}

/** For root claims, map normalized absolute paths to their paths from the
 * checkout. The original entries are still used for other comparisons and
 * in overlap messages. */
export function resolvePathsFromCheckout(
  checkoutRoot: string | undefined,
  claims: readonly (readonly string[])[],
  files?: readonly string[],
): ReadonlyMap<string, string> | undefined {
  if (checkoutRoot === undefined || !claims.some((entries) => entries.some(isRootClaim))) {
    return undefined;
  }

  const absolutePaths = new Set((files ?? claims.flat()).map(normalizePath).filter(isAbsolute));
  if (absolutePaths.size === 0) return undefined;

  const root = resolveExistingParents(checkoutRoot);
  const pathsFromCheckout = new Map<string, string>();
  for (const path of absolutePaths) {
    pathsFromCheckout.set(path, relative(root, resolveExistingParents(path)).replaceAll('\\', '/'));
  }
  return pathsFromCheckout;
}
