import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory name the plugin is discovered under, and its invocation name. */
export const RELAY_PLUGIN_NAME = 'concord-relay';

/**
 * The relay plugin shipped inside this package.
 *
 * Walks up from the calling module rather than counting `..` segments, because
 * the caller sits at a different depth in `src/` than in `dist/` and a
 * hard-coded count resolves to a plausible path that simply does not exist.
 * Returns undefined when no packaged plugin is above the caller.
 */
export function packagedPluginPath(moduleUrl: string): string | undefined {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'plugin', RELAY_PLUGIN_NAME);
    if (existsSync(join(candidate, '.claude-plugin', 'plugin.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Where Claude Code discovers plugins with no marketplace and no install step:
 * any directory under the skills directory holding a `.claude-plugin/`
 * manifest loads on the next session.
 */
export function claudeSkillsPluginPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), 'skills', RELAY_PLUGIN_NAME);
}

/** Claude Code's user directory: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env['CLAUDE_CONFIG_DIR'];
  return configDir !== undefined && configDir.trim() !== ''
    ? configDir
    : join(env['HOME'] ?? homedir(), '.claude');
}

/**
 * Link the packaged relay plugin into Claude Code's skills directory.
 *
 * A symlink rather than a copy, so upgrading the package upgrades the plugin —
 * the install path does not change between versions. Returns the link path, or
 * undefined when the plugin is not present (a source checkout that has not been
 * packaged, for instance) so setup can carry on rather than fail.
 *
 * This writes outside the repository, like the Codex config installer does, and
 * for the same reason: the plugin has to be visible to every session, not just
 * sessions started in one project.
 */
export function installClaudeRelayPlugin(
  moduleUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const source = packagedPluginPath(moduleUrl);
  if (source === undefined) return undefined;

  const target = claudeSkillsPluginPath(env);
  mkdirSync(dirname(target), { recursive: true });

  if (existsSync(target) || isBrokenLink(target)) {
    // Re-point a stale link (an older install path) but never clobber a real
    // directory someone put there by hand.
    if (!isSymlink(target)) return target;
    if (readlinkSync(target) === source) return target;
    rmSync(target);
  }
  symlinkSync(source, target);
  return target;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A symlink whose target is gone: `existsSync` follows links and says false. */
function isBrokenLink(path: string): boolean {
  return isSymlink(path) && !existsSync(path);
}
