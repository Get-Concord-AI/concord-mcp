import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { userHome } from '../config/paths.js';
import { executablePath } from './adapters/probe.js';
import {
  agentKindEnv,
  hasMcpServer,
  isConcordServerOwned,
  removeMcpServer,
  upsertMcpServer,
} from './mcp-config.js';

/**
 * Cline keeps one global MCP settings file shared by its CLI, the VS Code
 * extension, and JetBrains surfaces — there is no project-scoped MCP config.
 * `CLINE_MCP_SETTINGS_PATH` overrides the file, `CLINE_DATA_DIR` its parent
 * `settings/` directory's grandparent, and `CLINE_DIR` the `~/.cline` root.
 * Lifecycle hooks live in `~/Documents/Cline/Hooks` (read by every surface)
 * and `~/.cline/hooks` (SDK/CLI), again relocatable through `CLINE_DIR`.
 */

export function clineHome(env: NodeJS.ProcessEnv): string {
  const configured = env['CLINE_DIR']?.trim();
  return configured === undefined || configured === '' ? join(userHome(env), '.cline') : configured;
}

export function clineDataDir(env: NodeJS.ProcessEnv): string {
  const configured = env['CLINE_DATA_DIR']?.trim();
  return configured === undefined || configured === '' ? join(clineHome(env), 'data') : configured;
}

export function clineMcpSettingsPath(env: NodeJS.ProcessEnv): string {
  const configured = env['CLINE_MCP_SETTINGS_PATH']?.trim();
  return configured === undefined || configured === ''
    ? join(clineDataDir(env), 'settings', 'cline_mcp_settings.json')
    : configured;
}

/** Cline's shared rules directory, read by the CLI and every extension surface. */
export function clineGlobalRulesDir(env: NodeJS.ProcessEnv): string {
  return join(clineHome(env), 'rules');
}

/** `~/Documents/Cline` — the extension-facing half of Cline's global state. */
export function clineDocumentsDir(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), 'Documents', 'Cline');
}

/**
 * Global hook directories, most authoritative first. `Documents/Cline/Hooks`
 * is the only global directory the VS Code extension reads and the SDK also
 * scans it, so it is the canonical one; `~/.cline/hooks` additionally covers
 * SDK-only layouts when `CLINE_DIR` relocates state.
 */
export function clineGlobalHookDirs(env: NodeJS.ProcessEnv): string[] {
  return [join(clineDocumentsDir(env), 'Hooks'), join(clineHome(env), 'hooks')];
}

/** VS Code globalStorage locations for the Cline extension (`saoudrizwan.claude-dev`). */
function vscodeExtensionDirs(env: NodeJS.ProcessEnv): string[] {
  const home = userHome(env);
  const appDataEnv = env['APPDATA']?.trim();
  const appData =
    appDataEnv === undefined || appDataEnv === '' ? join(home, 'AppData', 'Roaming') : appDataEnv;
  const extension = join('User', 'globalStorage', 'saoudrizwan.claude-dev');
  return [
    join(appData, 'Code', extension),
    join(appData, 'Code - Insiders', extension),
    join(home, '.config', 'Code', extension),
    join(home, 'Library', 'Application Support', 'Code', extension),
  ];
}

/**
 * Whether any Cline surface is present: its CLI on PATH, its data or
 * Documents directories, or a VS Code-family extension install — including
 * an extension that has never run far enough to create `~/.cline`.
 */
export function clineDetected(env: NodeJS.ProcessEnv): boolean {
  return (
    executablePath('cline', env) !== undefined ||
    existsSync(clineHome(env)) ||
    existsSync(clineDocumentsDir(env)) ||
    vscodeExtensionDirs(env).some((dir) => existsSync(dir))
  );
}

/**
 * The lifecycle hooks Concord installs globally. File names are Cline's hook
 * names: the extension requires `<Name>.ps1` on Windows and an extensionless
 * executable elsewhere; the SDK accepts the same names on every platform.
 */
export interface ClineHookSpec {
  readonly fileStem: string;
  readonly event: string;
}

export const CLINE_HOOKS: readonly ClineHookSpec[] = [
  { fileStem: 'TaskStart', event: 'cline-task-start' },
  { fileStem: 'TaskResume', event: 'cline-task-resume' },
  { fileStem: 'UserPromptSubmit', event: 'cline-user-prompt-submit' },
];

/** Marker every Concord hook file carries, so uninstall never removes a user's own hook. */
const CLINE_HOOK_MARKER = 'concord:cline-hook';

function clineHookFileName(spec: ClineHookSpec): string {
  return process.platform === 'win32' ? `${spec.fileStem}.ps1` : spec.fileStem;
}

function clineHookContent(spec: ClineHookSpec): string {
  if (process.platform === 'win32') {
    return (
      `# ${CLINE_HOOK_MARKER}\n` +
      '$payload = [Console]::In.ReadToEnd()\n' +
      `$payload | & concord hook ${spec.event}\n`
    );
  }
  return `#!/bin/sh\n# ${CLINE_HOOK_MARKER}\nexec concord hook ${spec.event}\n`;
}

function isConcordHookFile(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(CLINE_HOOK_MARKER);
  } catch {
    return false;
  }
}

/** Expected hook file names for this platform, per hook spec. */
export function clineHookFileNames(): string[] {
  return CLINE_HOOKS.map(clineHookFileName);
}

/** Whether one hook directory holds every Concord hook file. */
export function clineHooksPresent(dir: string): 'present' | 'missing' | 'partial' {
  const names = clineHookFileNames();
  let found = 0;
  for (const name of names) {
    const path = join(dir, name);
    if (existsSync(path) && isConcordHookFile(path)) found += 1;
  }
  if (found === names.length) return 'present';
  return found === 0 ? 'missing' : 'partial';
}

/**
 * Register the Concord MCP server in Cline's global settings and install the
 * lifecycle hooks in both global hook directories. A `concord` entry the user
 * wrote themselves is preserved; unrelated servers and settings always are.
 * Returns the absolute paths written.
 */
export function installClineUserConfigs(env: NodeJS.ProcessEnv): string[] {
  const written: string[] = [];
  const mcpPath = clineMcpSettingsPath(env);
  const existing = existsSync(mcpPath) ? readFileSync(mcpPath, 'utf8') : undefined;
  if (existing === undefined || !hasMcpServer(existing) || isConcordServerOwned(existing)) {
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(mcpPath, upsertMcpServer(existing, undefined, agentKindEnv('cline')));
    written.push(mcpPath);
  }
  for (const dir of clineGlobalHookDirs(env)) {
    for (const spec of CLINE_HOOKS) {
      const path = join(dir, clineHookFileName(spec));
      // A same-named file the user owns is never replaced: Cline runs one file
      // per hook name per directory, so Concord's copy would shadow theirs.
      if (existsSync(path) && !isConcordHookFile(path)) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, clineHookContent(spec));
      if (process.platform !== 'win32') chmodSync(path, 0o755);
      written.push(path);
    }
  }
  return written;
}

/** Remove only what Concord owns from Cline's user-level files. */
export function uninstallClineUserConfigs(env: NodeJS.ProcessEnv): void {
  const mcpPath = clineMcpSettingsPath(env);
  if (existsSync(mcpPath)) {
    try {
      const existing = readFileSync(mcpPath, 'utf8');
      if (hasMcpServer(existing) && isConcordServerOwned(existing)) {
        writeFileSync(mcpPath, removeMcpServer(existing));
      }
    } catch {
      // Unreadable or malformed config is left untouched.
    }
  }
  for (const dir of clineGlobalHookDirs(env)) {
    for (const name of clineHookFileNames()) {
      const path = join(dir, name);
      if (!existsSync(path) || !isConcordHookFile(path)) continue;
      try {
        rmSync(path);
      } catch {
        // A hook file that cannot be removed is left in place.
      }
    }
  }
}
