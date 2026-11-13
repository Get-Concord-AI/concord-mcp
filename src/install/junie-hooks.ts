import { join } from 'node:path';

import { userHome } from '../config/paths.js';
import {
  hooksInstalled,
  installHooks,
  removeHooks,
  removeHooksConfig,
  upsertHooksConfig,
} from './hooks-config.js';

function junieConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(userHome(env), '.junie', 'config.json');
}

const OPS = { configPath: junieConfigPath, commandPrefix: 'junie', label: 'Junie' };

export function upsertJunieHooksConfig(existing: string | undefined): string {
  return upsertHooksConfig(existing, OPS);
}

export function removeJunieHooksConfig(existing: string): string {
  return removeHooksConfig(existing, OPS);
}

export function installJunieHooks(env: NodeJS.ProcessEnv = process.env): string {
  return installHooks(OPS, env);
}

export function removeJunieHooks(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return removeHooks(OPS, env);
}

export function junieHooksInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  return hooksInstalled(OPS, env);
}
