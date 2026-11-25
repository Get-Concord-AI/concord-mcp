import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { userHome } from '../config/paths.js';

/** Cursor's global lifecycle hooks, which run the relay extension's hook script. */
const CURSOR_HOOKS = {
  sessionStart: {
    command:
      'node "$HOME/.cursor/extensions/get-concord-ai.concord-relay/cursor-hook.mjs" session-start',
    timeout: 15,
  },
  stop: {
    command: 'node "$HOME/.cursor/extensions/get-concord-ai.concord-relay/cursor-hook.mjs" stop',
    timeout: 15,
    loop_limit: 25,
  },
  sessionEnd: {
    command:
      'node "$HOME/.cursor/extensions/get-concord-ai.concord-relay/cursor-hook.mjs" session-end',
    timeout: 15,
  },
} as const;

function cursorHooksPath(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.cursor', 'hooks.json');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object.`);
  return parsed;
}

export function cursorHookInstalled(env: NodeJS.ProcessEnv): boolean {
  try {
    const config = readJsonObject(cursorHooksPath(env));
    const hooks = config['hooks'];
    if (!isRecord(hooks)) return false;
    return Object.entries(CURSOR_HOOKS).every(([event, expected]) => {
      const definitions = hooks[event];
      return (
        Array.isArray(definitions) &&
        definitions.some(
          (definition) => isRecord(definition) && definition['command'] === expected.command,
        )
      );
    });
  } catch {
    return false;
  }
}

export function installCursorHooks(env: NodeJS.ProcessEnv): void {
  const path = cursorHooksPath(env);
  const config = readJsonObject(path);
  const currentHooks = isRecord(config['hooks']) ? config['hooks'] : {};
  const nextHooks: Record<string, unknown> = { ...currentHooks };
  for (const [event, expected] of Object.entries(CURSOR_HOOKS)) {
    const currentValue: unknown = currentHooks[event];
    const current: unknown[] = Array.isArray(currentValue) ? currentValue : [];
    const retained = current.filter(
      (definition) => !isRecord(definition) || definition['command'] !== expected.command,
    );
    nextHooks[event] = [...retained, expected];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...config, version: 1, hooks: nextHooks }, null, 2)}\n`, {
    mode: 0o600,
  });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

export function uninstallCursorHooks(env: NodeJS.ProcessEnv): void {
  const path = cursorHooksPath(env);
  if (!existsSync(path)) return;
  const config = readJsonObject(path);
  const currentHooks = config['hooks'];
  if (!isRecord(currentHooks)) return;
  const nextHooks: Record<string, unknown> = { ...currentHooks };
  for (const [event, expected] of Object.entries(CURSOR_HOOKS)) {
    const current = currentHooks[event];
    if (!Array.isArray(current)) continue;
    nextHooks[event] = current.filter(
      (definition) => !isRecord(definition) || definition['command'] !== expected.command,
    );
  }
  writeFileSync(path, `${JSON.stringify({ ...config, hooks: nextHooks }, null, 2)}\n`, {
    mode: 0o600,
  });
}
