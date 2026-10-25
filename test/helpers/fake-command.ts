import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Put an executable `name` in `directory` that runs the Node `script`.
 * Windows gets `name.cmd`, the shape npm installs CLIs in there; elsewhere
 * an extensionless sh launcher. Returns the launcher's path.
 */
export function writeFakeCommand(directory: string, name: string, script = ''): string {
  const source = join(directory, `${name}.fake.mjs`);
  writeFileSync(source, script);
  if (process.platform === 'win32') {
    const launcher = join(directory, `${name}.cmd`);
    writeFileSync(launcher, `@"${process.execPath}" "${source}" %*\r\n`);
    return launcher;
  }
  const launcher = join(directory, name);
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${source}" "$@"\n`);
  chmodSync(launcher, 0o755);
  return launcher;
}

/** A fake harness CLI that prints `version` for any arguments. */
export function writeFakeVersion(directory: string, name: string, version: string): string {
  return writeFakeCommand(directory, name, `console.log(${JSON.stringify(version)});\n`);
}
