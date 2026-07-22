// Regenerate src/version.ts from package.json so the CLI/server never report a
// version that has drifted from the published package. Wired to the `version`
// npm lifecycle script, so it runs automatically during `npm version <x>`.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

writeFileSync(
  new URL('src/version.ts', root),
  `/** Single source of truth for the package version, shared by the CLI and server. */\nexport const VERSION = '${pkg.version}';\n`,
);
