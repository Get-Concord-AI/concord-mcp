import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { isMap, isScalar, isSeq, parseDocument, Scalar, type Document } from 'yaml';

import { userHome } from '../config/paths.js';

const ENTRY_ID = 'concord-mcp';
const PLUGIN = '@deepseek-ai/dsh-mcp-client';
const OWNER_COMMENT = ' Managed by Concord MCP.';

/** DeepSeek's documented home override, including its supported tilde prefixes. */
export function deepseekHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['DSH_HOME']?.trim();
  if (configured === undefined || configured === '') return join(userHome(env), '.dsh');
  if (configured === '~') return userHome(env);
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return resolve(userHome(env), configured.slice(2));
  }
  return resolve(configured);
}

/** DSH applies this user patch after each profile's own configuration. */
export function deepseekConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(deepseekHome(env), 'cordis.patch.yml');
}

function parseConfig(existing: string) {
  const document: Document = parseDocument(existing, {
    // Preserve DSH expressions as tagged scalars; never evaluate user code during setup.
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error('DeepSeek cordis.patch.yml could not be parsed; the file was left untouched.');
  }
  document.contents ??= document.createNode([]);
  if (!isSeq(document.contents)) {
    throw new Error('DeepSeek cordis.patch.yml must contain a YAML patch list.');
  }
  if (document.contents.items.some((patch) => !isMap(patch))) {
    throw new Error('DeepSeek cordis.patch.yml patches must be mappings.');
  }
  return { document, patches: document.contents };
}

function expression(source: string): Scalar<string> {
  const scalar = new Scalar(source);
  scalar.tag = 'tag:yaml.org,2002:js';
  return scalar;
}

/** Merge a native MCP plugin row while retaining comments, expressions and other patches. */
export function upsertDeepseekConfig(existing = ''): string {
  const { document, patches } = parseConfig(existing);
  let installed = false;
  for (const patch of patches.items) {
    if (!isMap(patch)) continue;
    if (patch.get('id') === ENTRY_ID) {
      throw new Error('DeepSeek already patches concord-mcp; review that configuration manually.');
    }
    const patchConfig = patch.get('config', true);
    const patchedServers = isMap(patchConfig) ? patchConfig.get('servers', true) : undefined;
    if (isMap(patchedServers) && patchedServers.has('concord')) {
      throw new Error('DeepSeek already configures a concord MCP server; it was left untouched.');
    }
    const inserted = patch.get('insert', true);
    if (!isSeq(inserted)) continue;
    for (const entry of inserted.items) {
      if (!isMap(entry)) continue;
      const config = entry.get('config', true);
      const servers = isMap(config) ? config.get('servers', true) : undefined;
      if (isMap(servers) && servers.has('concord')) {
        throw new Error('DeepSeek already configures a concord MCP server; it was left untouched.');
      }
      if (entry.get('id') === ENTRY_ID) {
        const id = entry.get('id', true);
        if (
          installed ||
          !isScalar(id) ||
          id.comment !== OWNER_COMMENT ||
          entry.get('name') !== PLUGIN ||
          !isMap(config) ||
          config.get('serverName') !== 'concord'
        ) {
          throw new Error(
            'DeepSeek already defines concord-mcp; its configuration was left untouched.',
          );
        }
        // The installed row is also user-editable. Do not reset custom timeouts,
        // launchers, credentials or disabled state on a setup rerun.
        installed = true;
        continue;
      }
      if (entry.get('name') === PLUGIN && isMap(config) && config.get('serverName') === 'concord') {
        throw new Error('DeepSeek already registers a concord MCP server; it was left untouched.');
      }
    }
  }
  if (installed) return existing;
  const id = new Scalar(ENTRY_ID);
  id.comment = OWNER_COMMENT;
  const entry = document.createNode({
    id,
    name: PLUGIN,
    config: {
      serverName: 'concord',
      transport: 'stdio',
      command: 'concord-mcp',
      cwd: expression('process.cwd()'),
      env: {
        CONCORD_AGENT_KIND: 'deepseek',
        CONCORD_REPO_ROOT: expression('process.cwd()'),
      },
    },
  });
  patches.add(document.createNode({ insert: [entry] }));
  return document.toString();
}

/** Remove only the marked plugin row; preserve other rows even in the same insert patch. */
export function removeDeepseekConfig(existing: string): string {
  const { document, patches } = parseConfig(existing);
  let changed = false;
  for (let index = patches.items.length - 1; index >= 0; index -= 1) {
    const patch = patches.items[index];
    if (!isMap(patch)) continue;
    const inserted = patch.get('insert', true);
    if (!isSeq(inserted)) continue;
    for (let row = inserted.items.length - 1; row >= 0; row -= 1) {
      const entry = inserted.items[row];
      const id = isMap(entry) ? entry.get('id', true) : undefined;
      if (
        isMap(entry) &&
        entry.get('id') === ENTRY_ID &&
        entry.get('name') === PLUGIN &&
        isScalar(id) &&
        id.comment === OWNER_COMMENT
      ) {
        inserted.delete(row);
        changed = true;
      }
    }
    if (inserted.items.length === 0 && patch.items.length === 1) patches.delete(index);
  }
  return changed ? document.toString() : existing;
}

/** Whether the native row can spawn Concord and label it as DeepSeek. */
export function hasDeepseekConfig(existing: string): boolean {
  try {
    const { patches } = parseConfig(existing);
    if (patches.items.some((patch) => isMap(patch) && patch.get('id') === ENTRY_ID)) return false;
    return patches.items.some((patch) => {
      if (!isMap(patch)) return false;
      const inserted = patch.get('insert', true);
      if (!isSeq(inserted)) return false;
      return inserted.items.some((entry) => {
        if (!isMap(entry) || entry.get('name') !== PLUGIN) return false;
        const disabled = entry.get('disabled', true);
        if (disabled !== undefined && (!isScalar(disabled) || disabled.value !== false))
          return false;
        const config = entry.get('config', true);
        if (!isMap(config)) return false;
        const env = config.get('env', true);
        return (
          config.get('serverName') === 'concord' &&
          config.get('transport') === 'stdio' &&
          config.get('command') === 'concord-mcp' &&
          isMap(env) &&
          env.get('CONCORD_AGENT_KIND') === 'deepseek'
        );
      });
    });
  } catch {
    return false;
  }
}

export function installDeepseekConfig(env: NodeJS.ProcessEnv = process.env): void {
  const path = deepseekConfigPath(env);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const next = upsertDeepseekConfig(existing);
  if (next === existing) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, { mode: 0o600 });
}

export function uninstallDeepseekConfig(env: NodeJS.ProcessEnv = process.env): void {
  const path = deepseekConfigPath(env);
  if (!existsSync(path)) return;
  const existing = readFileSync(path, 'utf8');
  const next = removeDeepseekConfig(existing);
  if (next !== existing) writeFileSync(path, next);
}
