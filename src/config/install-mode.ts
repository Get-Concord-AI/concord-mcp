import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/** Marker the curl installer writes at the package root of a standalone install. */
export const STANDALONE_MARKER = 'standalone.json';

export const INSTALL_SCRIPT_URL =
  'https://github.com/Get-Concord-AI/concord-mcp/releases/latest/download/install.sh';

export const NPM_UPDATE_COMMAND = 'npm install -g @concord-ai/concord-mcp@latest';
export const STANDALONE_UPDATE_COMMAND = `curl -fsSL ${INSTALL_SCRIPT_URL} | sh`;

const standaloneMarkerSchema = z.object({
  /** Directory holding the `concord` and `concord-mcp` launchers. */
  binDir: z.string().min(1),
});

export interface StandaloneInstall {
  readonly binDir: string;
}

/** The package root: `dist/config/` (or `src/config/`) sits two levels below it. */
function packageRoot(moduleUrl: string): string {
  return fileURLToPath(new URL('../../', moduleUrl));
}

/**
 * The standalone install this package was unpacked by, or undefined for an
 * npm install or a checkout. A missing or malformed marker reads as npm.
 */
export function standaloneInstall(
  moduleUrl: string = import.meta.url,
): StandaloneInstall | undefined {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(packageRoot(moduleUrl), STANDALONE_MARKER), 'utf8'),
    );
    const parsed = standaloneMarkerSchema.safeParse(raw);
    return parsed.success ? { binDir: parsed.data.binDir } : undefined;
  } catch {
    return undefined;
  }
}

/** The command that upgrades Concord the way it was installed. */
export function updateCommand(moduleUrl: string = import.meta.url): string {
  return standaloneInstall(moduleUrl) === undefined
    ? NPM_UPDATE_COMMAND
    : STANDALONE_UPDATE_COMMAND;
}
