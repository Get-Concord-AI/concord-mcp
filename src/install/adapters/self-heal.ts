import { z } from 'zod';

import { harnessNames, type HarnessName } from '../../domain/harness-config.js';
import { isEphemeralPath, type EphemeralTest } from './links.js';
import {
  adapterNeedsAttention,
  installAdapter,
  statusAdapter,
  type AdapterReport,
} from './index.js';

/**
 * What a session's check of its own harness adapter found. `needs_install`
 * means the user has not opted in to automatic repair, so nothing changed.
 */
export const adapterCheckSchema = z.object({
  harness: z.enum(harnessNames),
  outcome: z.enum(['healthy', 'repaired', 'needs_install', 'repair_failed']),
  detail: z.string(),
});
export type AdapterCheck = z.infer<typeof adapterCheckSchema>;

export interface AdapterCheckOptions {
  moduleUrl: string;
  env: NodeJS.ProcessEnv;
  /** The user opted in to automatic adapter installation during setup. */
  autoAdapters: boolean;
  repoRoot?: string | undefined;
  isEphemeral?: EphemeralTest;
}

function check(harness: HarnessName, outcome: AdapterCheck['outcome'], report: AdapterReport) {
  return { harness, outcome, detail: report.detail };
}

/**
 * Check the adapter of the harness this session runs in, and install or repair
 * it when the user opted in. A harness added after `concord setup` otherwise
 * never gets its hooks, monitor, or SessionStart registration.
 */
export function ensureHarnessAdapter(
  harness: HarnessName,
  options: AdapterCheckOptions,
): AdapterCheck {
  const isEphemeral = options.isEphemeral ?? isEphemeralPath;
  const status = (): AdapterReport =>
    statusAdapter(harness, options.env, options.repoRoot, options.moduleUrl, isEphemeral);
  const before = status();
  if (!adapterNeedsAttention(before)) return check(harness, 'healthy', before);
  if (!options.autoAdapters) return check(harness, 'needs_install', before);
  try {
    installAdapter(harness, options.moduleUrl, options.env, isEphemeral);
  } catch (error) {
    return {
      harness,
      outcome: 'repair_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const after = status();
  return check(harness, after.status === 'installed' ? 'repaired' : 'repair_failed', after);
}
