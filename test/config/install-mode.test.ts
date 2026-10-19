import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  NPM_UPDATE_COMMAND,
  STANDALONE_MARKER,
  STANDALONE_UPDATE_COMMAND,
  standaloneInstall,
  standaloneUpdateCommand,
  standaloneUpgrade,
  updateCommand,
} from '../../src/config/install-mode.js';

/** A package root with a module at `dist/config/`, returning that module's URL. */
function packageModuleUrl(marker?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'concord-install-mode-'));
  mkdirSync(join(root, 'dist', 'config'), { recursive: true });
  if (marker !== undefined) writeFileSync(join(root, STANDALONE_MARKER), marker);
  return pathToFileURL(join(root, 'dist', 'config', 'install-mode.js')).href;
}

describe('install mode', () => {
  it('reads an npm install when there is no marker', () => {
    const moduleUrl = packageModuleUrl();
    expect(standaloneInstall(moduleUrl)).toBeUndefined();
    expect(updateCommand(moduleUrl)).toBe(NPM_UPDATE_COMMAND);
  });

  it('reads a standalone install and its locations from the marker', () => {
    const moduleUrl = packageModuleUrl(
      '{"binDir":"/home/me/.local/bin","installDir":"/home/me/.concord/standalone"}\n',
    );
    expect(standaloneInstall(moduleUrl)).toEqual({
      binDir: '/home/me/.local/bin',
      installDir: '/home/me/.concord/standalone',
    });
  });

  it('suggests the plain installer command for the default locations', () => {
    const install = { binDir: '/home/me/.local/bin', installDir: '/home/me/.concord/standalone' };
    expect(standaloneUpdateCommand(install, '/home/me')).toBe(STANDALONE_UPDATE_COMMAND);
  });

  it('keeps custom locations in the suggested command', () => {
    const install = { binDir: '/opt/bin', installDir: "/opt/it's concord" };
    expect(standaloneUpdateCommand(install, '/home/me')).toBe(
      `${STANDALONE_UPDATE_COMMAND.replace('| sh', '|')} ` +
        "CONCORD_INSTALL_DIR='/opt/it'\\''s concord' CONCORD_BIN_DIR=/opt/bin sh",
    );
  });

  it('passes the install locations to the installer on upgrade', () => {
    const upgrade = standaloneUpgrade({ binDir: '/opt/bin', installDir: '/opt/concord' });
    expect(upgrade.env).toEqual({
      CONCORD_INSTALL_DIR: '/opt/concord',
      CONCORD_BIN_DIR: '/opt/bin',
    });
  });

  it('fails the upgrade when the installer download fails', () => {
    const bin = mkdtempSync(join(tmpdir(), 'concord-fake-curl-'));
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 22\n');
    chmodSync(join(bin, 'curl'), 0o755);
    const upgrade = standaloneUpgrade({ binDir: '/opt/bin', installDir: '/opt/concord' });
    const result = spawnSync(upgrade.command, upgrade.args, {
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
    expect(result.status).toBe(22);
  });

  it('falls back to npm for a malformed marker', () => {
    expect(standaloneInstall(packageModuleUrl('not json'))).toBeUndefined();
    expect(standaloneInstall(packageModuleUrl('{"binDir":"","installDir":"/x"}'))).toBeUndefined();
    expect(standaloneInstall(packageModuleUrl('{"binDir":"/x"}'))).toBeUndefined();
  });

  it('treats this checkout as an npm install', () => {
    expect(standaloneInstall()).toBeUndefined();
  });
});
