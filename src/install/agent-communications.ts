import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { z } from 'zod';

export const communicationProviderValues = ['codex', 'claude', 'cursor'] as const;
export type CommunicationProvider = (typeof communicationProviderValues)[number];

const configSchema = z.object({
  version: z.literal(1),
  approved: z.boolean(),
  providers: z.array(z.enum(communicationProviderValues)),
  transport: z.literal('local-socket'),
});
export type AgentCommunicationConfig = z.infer<typeof configSchema>;

export const AGENT_COMMUNICATION_CONFIG = 'agent-integrations.json';

export function agentCommunicationConfigPath(concordPath: string): string {
  return join(concordPath, AGENT_COMMUNICATION_CONFIG);
}

function executableExists(name: string, env: NodeJS.ProcessEnv): boolean {
  const path = env['PATH'];
  if (path === undefined) return false;
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return path
    .split(delimiter)
    .some((directory) =>
      suffixes.some((suffix) => existsSync(join(directory, `${name}${suffix}`))),
    );
}

/** Detect supported clients without executing them or mutating client state. */
export function detectCommunicationProviders(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): CommunicationProvider[] {
  const detected: CommunicationProvider[] = [];
  if (executableExists('codex', env) || existsSync(join(repoRoot, '.codex')))
    detected.push('codex');
  if (executableExists('claude', env) || existsSync(join(repoRoot, '.claude'))) {
    detected.push('claude');
  }
  if (executableExists('cursor', env) || existsSync(join(repoRoot, '.cursor'))) {
    detected.push('cursor');
  }
  return detected;
}

export function readAgentCommunicationConfig(
  concordPath: string,
): AgentCommunicationConfig | undefined {
  const path = agentCommunicationConfigPath(concordPath);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return configSchema.parse(parsed);
  } catch {
    return undefined;
  }
}

/** Persist the user's one-time integration decision in ignored local state. */
export function writeAgentCommunicationConfig(
  concordPath: string,
  approved: boolean,
  providers: readonly CommunicationProvider[],
): string {
  const path = agentCommunicationConfigPath(concordPath);
  const config: AgentCommunicationConfig = {
    version: 1,
    approved,
    providers: approved ? [...providers] : [],
    transport: 'local-socket',
  };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}
