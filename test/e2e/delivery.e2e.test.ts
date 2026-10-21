import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { CodexSession } from './drivers/codex.js';
import { DRIVEN, DRIVERS, type DrivenHarness } from './drivers/index.js';
import type { HarnessSession } from './drivers/session.js';
import type { Channel, Delivered } from './support/messages.js';
import { Sandbox } from './support/sandbox.js';
import { inspectAgent, nonce, prompt, reply, untilIdleReachable } from './support/scenario.js';

/**
 * Every harness sends to every harness, with the recipient busy (mid-turn) and,
 * where its adapter supports it, idle (at the prompt, kept reachable by
 * whatever its adapter installed). A harness with no idle receiver is checked
 * for the opposite: the sender is told the message will wait, and it does.
 *
 * Each case checks that the sender was told the truth about delivery, that the
 * message arrived through the channel that harness promises, exactly once, and
 * that a reply finds its way back.
 */

interface Expectation {
  /** The channel that must hand the message over. */
  via: Channel;
  delivery: 'delivered' | 'queued_pull';
  immediateMode: 'inject' | 'steer' | null;
  outlook: RegExp;
}

/** Per harness, what each state it can be reached in promises. No `idle`: none. */
const EXPECTED: Record<DrivenHarness, { busy: Expectation; idle?: Expectation }> = {
  'claude-code': {
    busy: {
      via: 'post-tool-use',
      delivery: 'queued_pull',
      immediateMode: null,
      outlook: /only checks between steps/u,
    },
    idle: {
      via: 'monitor',
      delivery: 'queued_pull',
      immediateMode: null,
      outlook: /can be injected now/u,
    },
  },
  codex: {
    busy: {
      via: 'turn/steer',
      delivery: 'delivered',
      immediateMode: 'steer',
      outlook: /steering for its active turn/u,
    },
    idle: {
      via: 'turn/start',
      delivery: 'delivered',
      immediateMode: 'inject',
      outlook: /started a new turn/u,
    },
  },
  cursor: {
    busy: {
      via: 'followup',
      delivery: 'queued_pull',
      immediateMode: null,
      outlook: /only checks between steps/u,
    },
    idle: {
      via: 'monitor',
      delivery: 'queued_pull',
      immediateMode: null,
      outlook: /arrive on its own/u,
    },
  },
  antigravity: {
    busy: {
      via: 'pre-invocation',
      delivery: 'queued_pull',
      immediateMode: null,
      outlook: /only checks between steps/u,
    },
  },
};

const CASES = DRIVEN.flatMap((sender) =>
  DRIVEN.flatMap((receiver) =>
    (['busy', 'idle'] as const)
      .filter((state) => EXPECTED[receiver][state] !== undefined)
      .map((state) => ({ sender, receiver, state })),
  ),
);

/** Everything a session has been handed for `messageId`, across every channel. */
function copiesOf(seen: readonly Delivered[], messageId: string): Delivered[] {
  return seen.filter((message) => message.messageId === messageId);
}

/** Step a session's busy hooks, watching its idle receiver too, until `messageId` shows up. */
async function receiveAnyhow(session: HarnessSession, messageId: string): Promise<Delivered[]> {
  const seen: Delivered[] = [];
  const deadline = Date.now() + 15_000;
  for (;;) {
    const all = [...session.idleReceived(), ...seen];
    if (copiesOf(all, messageId).length > 0) return all;
    if (Date.now() > deadline) throw new Error(`${session.agentId} never received ${messageId}.`);
    seen.push(...(await session.receiveBusy()));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('cross-harness message delivery', () => {
  let sandbox: Sandbox;
  let sessions: HarnessSession[] = [];

  beforeAll(async () => {
    sandbox = Sandbox.create('delivery', inject('concordPrefix'));
    const setup = await sandbox.concord(['setup'], { timeoutMs: 60_000 });
    expect(setup.status).toBe(0);
  });

  afterEach(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    sessions = [];
  });

  afterAll(() => {
    sandbox.dispose();
  });

  function open(harness: DrivenHarness): HarnessSession {
    const session = new DRIVERS[harness](sandbox);
    sessions.push(session);
    return session;
  }

  it.each(CASES)('$sender → $receiver ($state)', async ({ sender, receiver, state }) => {
    const to = open(receiver);
    to.prepare(state);
    await to.start();
    const from = open(sender);
    await from.start();
    if (state === 'idle') {
      await to.startIdleReceiver();
      await untilIdleReachable(from, to);
    }

    const body = nonce(`${sender}-to-${receiver}-${state}`);
    const sent = await prompt(from, to, body);
    const expected = EXPECTED[receiver][state];
    if (expected === undefined) throw new Error(`${receiver} cannot be reached ${state}.`);
    expect(sent.recipient_agent_id).toBe(to.agentId);
    expect(sent.delivery).toBe(expected.delivery);
    expect(sent.immediate_mode).toBe(expected.immediateMode);
    expect(sent.outlook).toMatch(expected.outlook);

    // Arrives through the channel this harness promises for this state.
    const arrived =
      state === 'idle'
        ? [await to.waitForIdle(sent.message_id)]
        : copiesOf(await to.receiveBusy(), sent.message_id);
    expect(arrived).toEqual([
      { messageId: sent.message_id, sender: from.agentId, content: body, via: expected.via },
    ]);

    // Exactly once: no other channel hands it over again.
    const later = [...(await to.receiveBusy()), ...(await to.endTurn()).messages];
    expect(copiesOf(later, sent.message_id)).toEqual([]);
    expect(copiesOf(to.idleReceived(), sent.message_id).length).toBe(state === 'idle' ? 1 : 0);

    // The reply threads back to the sender.
    const answer = nonce('reply');
    const replied = await reply(to, sent.message_id, answer);
    expect(replied.recipient_agent_id).toBe(from.agentId);
    // Whichever channel the sender's harness offers in its current state.
    const received = copiesOf(await receiveAnyhow(from, replied.message_id), replied.message_id);
    expect(
      received.map(({ messageId, sender, content }) => ({ messageId, sender, content })),
    ).toEqual([{ messageId: replied.message_id, sender: to.agentId, content: answer }]);
  });

  const UNREACHABLE_IDLE = DRIVEN.filter((harness) => EXPECTED[harness].idle === undefined);

  it.each(UNREACHABLE_IDLE)(
    'tells the sender an idle %s session will see it next turn, and delivers it then',
    async (receiver) => {
      const to = open(receiver);
      await to.start();
      await to.endTurn();
      const from = open('claude-code');
      await from.start();

      const body = nonce(`${receiver}-idle`);
      const sent = await prompt(from, to, body);
      expect(sent.delivery).toBe('queued_pull');
      expect(sent.outlook).toMatch(/will not see this until its next turn/u);

      // Nothing hands it over while the session sits idle.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const waiting = await inspectAgent(from, to);
      expect(waiting.inbox.find((message) => message.messageId === sent.message_id)?.status).toBe(
        'pending',
      );

      // The next turn's first busy-path hook delivers it.
      expect(copiesOf(await to.receiveBusy(), sent.message_id)).toEqual([
        {
          messageId: sent.message_id,
          sender: from.agentId,
          content: body,
          via: EXPECTED[receiver].busy.via,
        },
      ]);
    },
  );

  it('reaches a Codex session through its hooks when the controller is down', async () => {
    const to = new CodexSession(sandbox);
    sessions.push(to);
    to.setController('down');
    await to.start();
    const from = open('claude-code');
    await from.start();

    const body = nonce('codex-fallback');
    const sent = await prompt(from, to, body);
    expect(sent.delivery).toBe('queued_pull');
    expect(sent.outlook).toMatch(/only checks between steps/u);
    expect(copiesOf(await to.receiveBusy(), sent.message_id)).toEqual([
      { messageId: sent.message_id, sender: from.agentId, content: body, via: 'post-tool-use' },
    ]);
    expect(copiesOf((await to.endTurn()).messages, sent.message_id)).toEqual([]);
  });
});
