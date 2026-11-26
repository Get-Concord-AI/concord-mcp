import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { userHome } from '../config/paths.js';
import { executablePath } from './adapters/probe.js';
import {
  agentKindEnv,
  CONCORD_SERVER_KEY,
  hasMcpServer,
  removeMcpServer,
  upsertMcpServer,
} from './mcp-config.js';

/**
 * Cline keeps one global MCP settings file shared by its CLI, the VS Code
 * extension, and JetBrains surfaces — there is no project-scoped MCP config.
 * `CLINE_MCP_SETTINGS_PATH` overrides the file, `CLINE_DATA_DIR` its parent
 * `settings/` directory's grandparent, and `CLINE_DIR` the `~/.cline` root.
 * Lifecycle hooks live under `<Documents>/Cline/Hooks` (the extension's
 * canonical directory, which the SDK also scans) and `~/.cline/hooks`
 * (SDK/CLI), again relocatable through `CLINE_DIR`.
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

/**
 * The OS Documents folder, resolved once per process exactly the way Cline's
 * `getDocumentsPath` resolves it: the `MyDocuments` known folder through
 * PowerShell on Windows, `xdg-user-dir DOCUMENTS` on Linux, `~/Documents`
 * as the shared fallback — so OneDrive folder redirection lands correctly.
 * `CONCORD_DOCUMENTS_DIR` overrides the lookup for tests and exotic setups.
 */
const DOCUMENTS_DIR_ENV = 'CONCORD_DOCUMENTS_DIR';

let osDocumentsDirCache: string | undefined;
let osDocumentsDirResolved = false;

function osDocumentsDir(): string | undefined {
  if (osDocumentsDirResolved) return osDocumentsDirCache;
  osDocumentsDirResolved = true;
  const lookup =
    process.platform === 'win32'
      ? {
          command: 'powershell',
          args: [
            '-NoProfile',
            '-Command',
            '[System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments)',
          ],
        }
      : process.platform === 'linux'
        ? { command: 'xdg-user-dir', args: ['DOCUMENTS'] }
        : undefined;
  if (lookup === undefined) return undefined;
  try {
    const result = spawnSync(lookup.command, lookup.args, {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    const dir = result.status === 0 ? result.stdout.trim() : '';
    if (dir !== '') osDocumentsDirCache = dir;
  } catch {
    // A missing helper falls through to the ~/Documents candidates.
  }
  return osDocumentsDirCache;
}

/**
 * The `Cline` state directories under Documents, deduplicated: the
 * OS-resolved one the VS Code extension reads first, then the literal
 * `~/Documents` the SDK resolver scans — the two differ when Windows folder
 * redirection moves Documents into OneDrive.
 */
export function clineDocumentsDirs(env: NodeJS.ProcessEnv): string[] {
  const override = env[DOCUMENTS_DIR_ENV] ?? process.env[DOCUMENTS_DIR_ENV];
  const trimmed = override?.trim();
  const osDocuments = trimmed === undefined || trimmed === '' ? osDocumentsDir() : trimmed;
  const dirs = osDocuments === undefined ? [] : [join(osDocuments, 'Cline')];
  dirs.push(join(userHome(env), 'Documents', 'Cline'));
  return [...new Set(dirs)];
}

/** The primary `Cline` state directory — the OS-resolved one when known. */
export function clineDocumentsDir(env: NodeJS.ProcessEnv): string {
  return clineDocumentsDirs(env)[0] ?? join(userHome(env), 'Documents', 'Cline');
}

/**
 * Global hook directories, most authoritative first. The first Documents
 * entry is the extension's canonical `Cline/Hooks`; the literal
 * `~/Documents/Cline/Hooks` covers the SDK's own Documents lookup under
 * OneDrive redirection, and `~/.cline/hooks` SDK-only layouts.
 */
export function clineGlobalHookDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs = clineDocumentsDirs(env).map((dir) => join(dir, 'Hooks'));
  dirs.push(join(clineHome(env), 'hooks'));
  return [...new Set(dirs)];
}

/** Environment markers OneDrive folder redirection sets on Windows. */
const ONEDRIVE_ENV_VARS = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'] as const;

/**
 * Every global rules directory Cline's resolver scans, Concord's own
 * `~/.cline/rules` first: the Documents `Cline/Rules` locations, the
 * `~/Cline/Rules` fallback, and the OneDrive-redirected candidates the SDK
 * adds for each marker variable.
 */
export function clineGlobalRulesDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs = [join(clineHome(env), 'rules')];
  for (const documentsDir of clineDocumentsDirs(env)) {
    dirs.push(join(documentsDir, 'Rules'));
  }
  dirs.push(join(userHome(env), 'Cline', 'Rules'));
  for (const key of ONEDRIVE_ENV_VARS) {
    const value = env[key]?.trim();
    if (value !== undefined && value !== '') {
      dirs.push(join(value, 'Documents', 'Cline', 'Rules'));
    }
  }
  return [...new Set(dirs)];
}

/** The `concord.md` path inside each global rules directory. */
export function clineGlobalRulesPaths(env: NodeJS.ProcessEnv): string[] {
  return clineGlobalRulesDirs(env).map((dir) => join(dir, 'concord.md'));
}

/**
 * The single `concord.md` install target: the first rules directory that
 * already exists, so an existing Cline layout gets the copy where its rules
 * already live. With no directory yet, the canonical `~/.cline/rules` is used.
 * Uninstall still scans `clineGlobalRulesPaths` to remove copies written by
 * earlier versions.
 */
export function clineGlobalRulesInstallPaths(env: NodeJS.ProcessEnv): string[] {
  const dir =
    clineGlobalRulesDirs(env).find((candidate) => existsSync(candidate)) ??
    join(clineHome(env), 'rules');
  return [join(dir, 'concord.md')];
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

/** Whether the Cline VS Code-family extension has a globalStorage directory. */
export function clineExtensionDetected(env: NodeJS.ProcessEnv): boolean {
  return vscodeExtensionDirs(env).some((dir) => existsSync(dir));
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
    clineDocumentsDirs(env).some((dir) => existsSync(dir)) ||
    clineExtensionDetected(env)
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
      // PS 5.1 pipes strings to native commands with $OutputEncoding, which
      // defaults to ASCII; the console encodings are left alone because their
      // setters throw when the streams are redirected, as they are here.
      '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n' +
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
 * The env Concord stamps on the `concord` entry it writes to Cline's MCP
 * settings. The marker is what proves Concord installed the entry: a
 * hand-written `concord-mcp` server — even one pinned with
 * `CONCORD_REPO_ROOT` — carries no marker and is left alone on both install
 * and uninstall.
 */
export const CLINE_MANAGED_ENV = 'CONCORD_MANAGED';

/** The env a Concord-written Cline MCP entry carries. */
export function clineManagedEnv(): Record<string, string> {
  return { ...agentKindEnv('cline'), [CLINE_MANAGED_ENV]: 'true' };
}

const clineEntrySchema = z.object({ env: z.record(z.string(), z.string()).optional() }).loose();

/** Whether the `concord` entry in Cline's settings carries Concord's marker. */
export function clineEntryIsManaged(existing: string): boolean {
  try {
    const config = z
      .object({ mcpServers: z.record(z.string(), z.unknown()).optional() })
      .loose()
      .parse(JSON.parse(existing));
    const entry = clineEntrySchema.safeParse(config.mcpServers?.[CONCORD_SERVER_KEY]);
    return entry.success && entry.data.env?.[CLINE_MANAGED_ENV] === 'true';
  } catch {
    return false;
  }
}

/**
 * Register the Concord MCP server in Cline's global settings and install the
 * lifecycle hooks in every global hook directory. A `concord` entry the user
 * wrote themselves — anything without Concord's managed marker — is
 * preserved; unrelated servers and settings always are. Returns the absolute
 * paths written.
 */
export function installClineUserConfigs(env: NodeJS.ProcessEnv): string[] {
  const written: string[] = [];
  const mcpPath = clineMcpSettingsPath(env);
  const existing = existsSync(mcpPath) ? readFileSync(mcpPath, 'utf8') : undefined;
  if (existing === undefined || !hasMcpServer(existing) || clineEntryIsManaged(existing)) {
    mkdirSync(dirname(mcpPath), { recursive: true });
    writeFileSync(mcpPath, upsertMcpServer(existing, undefined, clineManagedEnv()));
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
      if (hasMcpServer(existing) && clineEntryIsManaged(existing)) {
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
