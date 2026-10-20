import { z } from 'zod';

import type { AgentSessionAdapter, AgentSessionDelivery } from './server.js';

export interface CodexAppServerClient {
  request(method: 'turn/steer' | 'turn/start', params: Record<string, unknown>): Promise<unknown>;
}

/** Codex's supported app-server API: steer busy turns and start idle turns. */
export class CodexAppServerAdapter implements AgentSessionAdapter {
  readonly provider = 'codex';

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly threadId: string,
    private readonly currentTurnId: () => string | undefined,
  ) {}

  isBusy(): boolean {
    return this.currentTurnId() !== undefined;
  }

  async steer(delivery: AgentSessionDelivery): Promise<string | undefined> {
    const turnId = this.currentTurnId();
    if (turnId === undefined) throw new Error('Codex session has no active turn to steer.');
    await this.client.request('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text: delivery.content }],
    });
    return turnId;
  }

  async inject(delivery: AgentSessionDelivery): Promise<string | undefined> {
    const result = await this.client.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: delivery.content }],
    });
    return receiptFrom(result);
  }
}

export interface PushPromptSession {
  isBusy(): boolean;
  pushPrompt(content: string, mode: 'steer' | 'inject'): Promise<string | undefined>;
}

/** In-process contract used by version-gated Cursor, Gemini, and Grok bridges. */
export class PushPromptSessionAdapter implements AgentSessionAdapter {
  constructor(
    readonly provider: string,
    private readonly session: PushPromptSession,
  ) {}

  isBusy(): boolean {
    return this.session.isBusy();
  }

  steer(delivery: AgentSessionDelivery): Promise<string | undefined> {
    return this.session.pushPrompt(delivery.content, 'steer');
  }

  inject(delivery: AgentSessionDelivery): Promise<string | undefined> {
    return this.session.pushPrompt(delivery.content, 'inject');
  }
}

function receiptFrom(value: unknown): string | undefined {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) return undefined;
  for (const key of ['turnId', 'turn_id', 'id']) {
    if (typeof parsed.data[key] === 'string') return parsed.data[key];
  }
  return undefined;
}
