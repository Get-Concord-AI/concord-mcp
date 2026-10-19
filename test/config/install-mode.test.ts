import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  NPM_UPDATE_COMMAND,
  STANDALONE_MARKER,
  STANDALONE_UPDATE_COMMAND,
  standaloneInstall,
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

  it('reads a standalone install and its launcher directory from the marker', () => {
    const moduleUrl = packageModuleUrl('{"binDir":"/home/me/.local/bin"}\n');
    expect(standaloneInstall(moduleUrl)).toEqual({ binDir: '/home/me/.local/bin' });
    expect(updateCommand(moduleUrl)).toBe(STANDALONE_UPDATE_COMMAND);
  });

  it('falls back to npm for a malformed marker', () => {
    expect(standaloneInstall(packageModuleUrl('not json'))).toBeUndefined();
    expect(standaloneInstall(packageModuleUrl('{"binDir":""}'))).toBeUndefined();
  });

  it('treats this checkout as an npm install', () => {
    expect(standaloneInstall()).toBeUndefined();
  });
});
