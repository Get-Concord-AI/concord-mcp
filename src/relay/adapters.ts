import type { AgentSessionAdapter, AgentSessionDelivery } from './server.js';
import { z } from 'zod';

export interface CodexAppServerClient {
  request(method: 'turn/steer' | 'turn/start', params: Record<string, unknown>): Promise<unknown>;
}

/** Codex app-server adapter: an active turn is steered; idle starts a new turn. */
export class CodexAppServerAdapter implements AgentSessionAdapter {
  readonly provider = 'codex';

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly threadId: string,
    private readonly currentTurnId: () => string | undefined,
  ) {}

  async steer(delivery: AgentSessionDelivery): Promise<string | undefined> {
    const turnId = this.currentTurnId();
    if (turnId === undefined) throw new Error('Codex session has no active turn to steer.');
    await this.client.request('turn/steer', {
      threadId: this.threadId,
      turnId,
      input: [{ type: 'text', text: delivery.content }],
    });
    return turnId;
  }

  async startTurn(delivery: AgentSessionDelivery): Promise<string | undefined> {
    const result = await this.client.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: delivery.content }],
    });
    return receiptFrom(result);
  }
}

export interface PushPromptSession {
  pushPrompt(content: string, mode: 'steer' | 'start'): Promise<string | undefined>;
}

/** Claude managed-session adapter using its streaming-input prompt channel. */
export class ClaudeStreamingAdapter implements AgentSessionAdapter {
  readonly provider = 'claude';
  constructor(private readonly session: PushPromptSession) {}
  steer(delivery: AgentSessionDelivery) {
    return this.session.pushPrompt(delivery.content, 'steer');
  }
  startTurn(delivery: AgentSessionDelivery) {
    return this.session.pushPrompt(delivery.content, 'start');
  }
}

/** Cursor adapter for a client integration that exposes immediate follow-up injection. */
export class CursorSessionAdapter implements AgentSessionAdapter {
  readonly provider = 'cursor';
  constructor(private readonly session: PushPromptSession) {}
  steer(delivery: AgentSessionDelivery) {
    return this.session.pushPrompt(delivery.content, 'steer');
  }
  startTurn(delivery: AgentSessionDelivery) {
    return this.session.pushPrompt(delivery.content, 'start');
  }
}

function receiptFrom(value: unknown): string | undefined {
  const parsed = z.record(z.unknown()).safeParse(value);
  if (!parsed.success) return undefined;
  for (const key of ['turnId', 'turn_id', 'id']) {
    if (typeof parsed.data[key] === 'string') return parsed.data[key];
  }
  return undefined;
}
