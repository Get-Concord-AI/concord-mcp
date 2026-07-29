import { randomUUID } from 'node:crypto';
import { arch, platform, release } from 'node:os';

import { VERSION } from '../version.js';
import {
  loadTelemetryIdentity,
  markTelemetryNoticeShown,
  telemetryConfigFile,
  workspacePseudonym,
} from './identity.js';

export const DEFAULT_TELEMETRY_URL = 'https://getconcord.ai/api/telemetry/v1';
const FLUSH_DELAY_MS = 5_000;
const FETCH_TIMEOUT_MS = 1_500;
const MAX_BATCH_SIZE = 50;
const MAX_QUEUE_SIZE = 200;

export type TelemetrySurface = 'mcp' | 'cli';
export type TelemetryOutcome = 'success' | 'error';

interface QueuedEvent {
  event_id: string;
  sequence: number;
  occurred_at: string;
  event_type: 'session_started' | 'operation_completed';
  operation: string | null;
  outcome: TelemetryOutcome | null;
  duration_ms: number | null;
  workspace_id: string | null;
}

interface TelemetryClientOptions {
  surface: TelemetrySurface;
  workspaceRoot: () => string | undefined;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  stderr?: { write(message: string): unknown };
}

interface ClientInfo {
  name: string;
  version: string | null;
}

export class TelemetryClient {
  readonly #installationId: string;
  readonly #sessionId = randomUUID();
  readonly #workspaceKey: string;
  readonly #surface: TelemetrySurface;
  readonly #workspaceRoot: () => string | undefined;
  readonly #endpoint: string;
  readonly #fetcher: typeof fetch;
  readonly #ci: boolean;
  readonly #events: QueuedEvent[] = [];
  #clientInfo: ClientInfo | undefined;
  #sequence = 0;
  #timer: NodeJS.Timeout | undefined;
  #flushing = false;

  constructor(installationId: string, workspaceKey: string, options: TelemetryClientOptions) {
    this.#installationId = installationId;
    this.#workspaceKey = workspaceKey;
    this.#surface = options.surface;
    this.#workspaceRoot = options.workspaceRoot;
    this.#endpoint = options.env?.['CONCORD_TELEMETRY_URL'] ?? DEFAULT_TELEMETRY_URL;
    this.#fetcher = options.fetcher ?? fetch;
    this.#ci = (options.env ?? process.env)['CI'] !== undefined;
    this.#record('session_started', null, null, null);
  }

  setClientInfo(name: string, version: string): void {
    const normalizedName = /codex/iu.test(name)
      ? 'codex'
      : /claude/iu.test(name)
        ? 'claude'
        : /cursor/iu.test(name)
          ? 'cursor'
          : /gemini|google/iu.test(name)
            ? 'gemini'
            : /visual studio|vscode/iu.test(name)
              ? 'vscode'
              : 'other';
    this.#clientInfo = {
      name: normalizedName,
      version: /^[0-9A-Za-z.+_-]{1,40}$/u.test(version) ? version : null,
    };
  }

  recordOperation(operation: string, outcome: TelemetryOutcome, durationMs: number): void {
    this.#record('operation_completed', operation.slice(0, 80), outcome, durationMs);
  }

  async flush(): Promise<void> {
    if (this.#flushing || this.#events.length === 0) {
      return;
    }
    this.#flushing = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const events = this.#events.splice(0, MAX_BATCH_SIZE);
    try {
      await this.#fetcher(this.#endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schema_version: 1,
          installation_id: this.#installationId,
          session_id: this.#sessionId,
          sent_at: new Date().toISOString(),
          source: {
            surface: this.#surface,
            concord_version: VERSION,
            node_version: process.versions.node,
            platform: platform(),
            platform_release: release(),
            arch: arch(),
            ci: this.#ci,
            client_name: this.#clientInfo?.name ?? null,
            client_version: this.#clientInfo?.version ?? null,
          },
          events,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      // Usage data is best effort and must never affect the product.
    } finally {
      this.#flushing = false;
      if (this.#events.length > 0) {
        this.#scheduleFlush();
      }
    }
  }

  close(): Promise<void> {
    return this.flush();
  }

  #record(
    eventType: QueuedEvent['event_type'],
    operation: string | null,
    outcome: TelemetryOutcome | null,
    durationMs: number | null,
  ): void {
    if (this.#events.length >= MAX_QUEUE_SIZE) {
      this.#events.shift();
    }
    const root = this.#workspaceRoot();
    this.#events.push({
      event_id: randomUUID(),
      sequence: this.#sequence,
      occurred_at: new Date().toISOString(),
      event_type: eventType,
      operation,
      outcome,
      duration_ms:
        durationMs === null ? null : Math.min(86_400_000, Math.max(0, Math.round(durationMs))),
      workspace_id:
        root === undefined
          ? null
          : workspacePseudonym(
              {
                installationId: this.#installationId,
                workspaceKey: this.#workspaceKey,
                noticeShown: true,
              },
              root,
            ),
    });
    this.#sequence += 1;
    if (this.#events.length >= MAX_BATCH_SIZE) {
      void this.flush();
    } else {
      this.#scheduleFlush();
    }
  }

  #scheduleFlush(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.#timer.unref();
  }
}

export function createTelemetryClient(
  options: TelemetryClientOptions,
): TelemetryClient | undefined {
  const env = options.env ?? process.env;
  if (
    env['CONCORD_TELEMETRY_DISABLED'] === '1' ||
    env['DO_NOT_TRACK'] === '1' ||
    (env['NODE_ENV'] === 'test' && options.fetcher === undefined)
  ) {
    return undefined;
  }
  const configFile = telemetryConfigFile(env);
  const identity = loadTelemetryIdentity(configFile);
  if (identity === undefined) {
    return undefined;
  }
  if (!identity.noticeShown) {
    (options.stderr ?? process.stderr).write(
      'Concord sends anonymous usage telemetry (no code, paths, or task content). ' +
        'Disable with CONCORD_TELEMETRY_DISABLED=1.\n',
    );
    markTelemetryNoticeShown(configFile, identity);
  }
  return new TelemetryClient(identity.installationId, identity.workspaceKey, options);
}
