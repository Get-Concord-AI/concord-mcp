import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

const identitySchema = z.object({
  installation_id: z.string().uuid(),
  workspace_key: z.string().regex(/^[0-9a-f]{64}$/u),
  notice_shown: z.boolean(),
});

export interface TelemetryIdentity {
  installationId: string;
  workspaceKey: string;
  noticeShown: boolean;
}

export function telemetryConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env['XDG_CONFIG_HOME'] ??
    (process.platform === 'win32' ? env['APPDATA'] : undefined) ??
    join(homedir(), '.config');
  return join(base, 'concord', 'telemetry.json');
}

function persistIdentity(path: string, identity: TelemetryIdentity): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      `${JSON.stringify({
        installation_id: identity.installationId,
        workspace_key: identity.workspaceKey,
        notice_shown: identity.noticeShown,
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Load or create the anonymous identity. Failure disables telemetry. */
export function loadTelemetryIdentity(path: string): TelemetryIdentity | undefined {
  try {
    const parsed = identitySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    return {
      installationId: parsed.installation_id,
      workspaceKey: parsed.workspace_key,
      noticeShown: parsed.notice_shown,
    };
  } catch {
    const identity: TelemetryIdentity = {
      installationId: randomUUID(),
      workspaceKey: randomBytes(32).toString('hex'),
      noticeShown: false,
    };
    return persistIdentity(path, identity) ? identity : undefined;
  }
}

export function markTelemetryNoticeShown(path: string, identity: TelemetryIdentity): void {
  if (!identity.noticeShown && persistIdentity(path, { ...identity, noticeShown: true })) {
    identity.noticeShown = true;
  }
}

/** Stable only for this installation; the canonical path and key never leave the machine. */
export function workspacePseudonym(identity: TelemetryIdentity, repoRoot: string): string {
  return createHmac('sha256', identity.workspaceKey).update(repoRoot).digest('hex');
}
