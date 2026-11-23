import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Whether the current platform and user have permission to create file symlinks.
 * On Windows, this requires either administrative privileges or Developer Mode.
 */
export function canSymlinkFile(): boolean {
  if (process.platform !== 'win32') return true;
  // A private directory per probe keeps parallel test workers from colliding.
  const dir = mkdtempSync(join(tmpdir(), 'concord-probe-'));
  try {
    const probeTarget = join(dir, 'target');
    writeFileSync(probeTarget, '');
    symlinkSync(probeTarget, join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
