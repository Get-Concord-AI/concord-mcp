import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
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
  /** Directory the installer unpacks releases into. */
  installDir: z.string().min(1),
});

export interface StandaloneInstall {
  readonly binDir: string;
  readonly installDir: string;
}

/** How to rerun the installer so it replaces this install in place. */
export interface StandaloneUpgrade {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
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
    return parsed.success
      ? { binDir: parsed.data.binDir, installDir: parsed.data.installDir }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A path inside this package, re-rooted at the standalone install's `current`
 * link. Modules resolve to their version directory, which the installer prunes
 * two upgrades later; links written through `current` follow every upgrade.
 */
export function upgradeStablePath(path: string, moduleUrl: string = import.meta.url): string {
  const install = standaloneInstall(moduleUrl);
  const root = packageRoot(moduleUrl);
  if (install === undefined || !path.startsWith(root)) return path;
  return join(install.installDir, 'current', 'lib', path.slice(root.length));
}

/** The installer's settings that keep an upgrade in this install's locations. */
function locationEnv(install: StandaloneInstall): Record<string, string> {
  return { CONCORD_INSTALL_DIR: install.installDir, CONCORD_BIN_DIR: install.binDir };
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command a person runs to upgrade a standalone install. */
export function standaloneUpdateCommand(
  install: StandaloneInstall,
  home: string = homedir(),
): string {
  // install.sh is POSIX-only, so its defaults are POSIX paths on every host.
  const defaults = {
    installDir: posix.join(home, '.concord', 'standalone'),
    binDir: posix.join(home, '.local', 'bin'),
  };
  if (install.installDir === defaults.installDir && install.binDir === defaults.binDir) {
    return STANDALONE_UPDATE_COMMAND;
  }
  const settings = Object.entries(locationEnv(install))
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(' ');
  return `curl -fsSL ${INSTALL_SCRIPT_URL} | ${settings} sh`;
}

/**
 * Rerun the installer for an upgrade. The script is downloaded before it runs,
 * so a failed download fails the upgrade instead of piping nothing into `sh`.
 */
export function standaloneUpgrade(install: StandaloneInstall): StandaloneUpgrade {
  return {
    command: 'sh',
    args: [
      '-c',
      'script="$(mktemp)" || exit 1\n' +
        'curl -fsSL "$1" -o "$script" && sh "$script"\n' +
        'status=$?\n' +
        'rm -f "$script"\n' +
        'exit "$status"',
      'concord-upgrade',
      INSTALL_SCRIPT_URL,
    ],
    env: locationEnv(install),
  };
}

/** The command that upgrades Concord the way it was installed. */
export function updateCommand(moduleUrl: string = import.meta.url): string {
  const install = standaloneInstall(moduleUrl);
  return install === undefined ? NPM_UPDATE_COMMAND : standaloneUpdateCommand(install);
}
