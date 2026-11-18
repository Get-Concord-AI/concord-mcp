import { dirname, join } from 'node:path';

import { devinMcpConfigPath } from './devin-config.js';
import {
  hooksInstalled,
  installHooks,
  removeHooks,
  removeHooksConfig,
  upsertHooksConfig,
} from './hooks-config.js';

function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(devinMcpConfigPath(env)), 'config.json');
}

const OPS = { configPath: userConfigPath, commandPrefix: 'devin', label: 'Devin' };

export function upsertDevinUserHooksConfig(existing: string | undefined): string {
  return upsertHooksConfig(existing, OPS);
}

export function removeDevinUserHooksConfig(existing: string): string {
  return removeHooksConfig(existing, OPS);
}

export function installDevinUserHooks(env: NodeJS.ProcessEnv = process.env): string {
  return installHooks(OPS, env);
}

export function removeDevinUserHooks(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return removeHooks(OPS, env);
}

export function devinUserHooksInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  return hooksInstalled(OPS, env);
}
