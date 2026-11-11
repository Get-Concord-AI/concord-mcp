import { z } from 'zod';

import type { PushPromptSession } from './adapters.js';
import type { OpenCodeRequest } from './opencode-api.js';

/**
 * Relay client for one session on an OpenCode 2 server.
 *
 * Prompts go to `POST /api/session/:id/prompt` with `delivery: 'steer'` for a
 * running turn or `'queue'` to start one. Whether a turn is running comes from
 * `GET /api/session/active`, which lists sessions with a live drain and omits
 * idle ones. The event stream's payloads are not part of the published OpenAPI
 * spec, so busy state and liveness are polled from documented endpoints.
 * Requests are made through `request` (see `opencode-api.ts`), which owns auth.
 */

const POLL_EVERY_MS = 1_000;
/** Consecutive failed polls before the server is treated as gone (OpenCode exited). */
const MAX_FAILED_POLLS = 3;

const activeSchema = z.object({
  data: z.record(z.string(), z.object({ type: z.string() }).loose()),
});
const promptReplySchema = z.object({ data: z.object({ id: z.string() }).loose() });

export interface OpenCodeSessionOptions {
  request: OpenCodeRequest;
  sessionId: string;
  pollEveryMs?: number;
}

/** One OpenCode session behind a server. */
export class OpenCodeServerClient implements PushPromptSession {
  private busy = false;
  private closed = false;
  private failedPolls = 0;
  private polling = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly closedListeners: (() => void)[] = [];

  constructor(private readonly options: OpenCodeSessionOptions) {}

  isBusy(): boolean {
    return this.busy;
  }

  /** Read the session's state once, then keep following it until the server goes away. */
  async connect(): Promise<void> {
    await this.poll(true);
    this.timer = setInterval(() => {
      void this.poll(false);
    }, this.options.pollEveryMs ?? POLL_EVERY_MS);
    this.timer.unref();
  }

  /** Steer the running turn, or queue a prompt that starts one. */
  async pushPrompt(content: string, mode: 'steer' | 'inject'): Promise<string | undefined> {
    const reply = await this.options.request(
      'POST',
      `/api/session/${encodeURIComponent(this.options.sessionId)}/prompt`,
      JSON.stringify({ text: content, delivery: mode === 'steer' ? 'steer' : 'queue' }),
    );
    if (mode === 'inject') this.busy = true;
    try {
      const parsed = promptReplySchema.safeParse(JSON.parse(reply));
      return parsed.success ? parsed.data.data.id : undefined;
    } catch {
      return undefined;
    }
  }

  /** Run `listener` once the server goes away — at once if it already has. */
  onClosed(listener: () => void): void {
    if (this.closed) {
      listener();
      return;
    }
    this.closedListeners.push(listener);
  }

  close(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll at a time: a slow service must not stack requests or reorder their answers. */
  private async poll(initial: boolean): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const reply = await this.options.request('GET', '/api/session/active');
      const parsed = activeSchema.parse(JSON.parse(reply));
      this.busy = parsed.data[this.options.sessionId] !== undefined;
      this.failedPolls = 0;
    } catch (error) {
      if (initial) throw error instanceof Error ? error : new Error(String(error));
      this.failedPolls += 1;
      if (this.failedPolls >= MAX_FAILED_POLLS) this.shutDown();
    } finally {
      this.polling = false;
    }
  }

  private shutDown(): void {
    this.close();
    this.closed = true;
    for (const listener of this.closedListeners) listener();
  }
}
