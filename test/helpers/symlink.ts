import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Whether the current platform and user have permission to create file symlinks.
 * On Windows, this requires either administrative privileges or Developer Mode.
 */
export function canSymlinkFile(): boolean {
  if (process.platform !== 'win32') return true;
  try {
    const probeTarget = join(tmpdir(), `concord-probe-target-${String(Date.now())}`);
    const probeLink = join(tmpdir(), `concord-probe-link-${String(Date.now())}`);
    writeFileSync(probeTarget, '');
    try {
      symlinkSync(probeTarget, probeLink);
      rmSync(probeLink);
      return true;
    } finally {
      rmSync(probeTarget);
    }
  } catch {
    return false;
  }
}
