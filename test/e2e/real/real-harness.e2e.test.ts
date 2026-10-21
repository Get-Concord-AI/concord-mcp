import { afterEach, beforeEach, describe, expect, inject, it, onTestFailed } from 'vitest';
import { z } from 'zod';

import { eventually } from '../support/messages.js';
import { Sandbox } from '../support/sandbox.js';
import { nonce } from '../support/scenario.js';
import { isShell, SILENT } from './fake-model/brain.js';
import { FakeModel } from './fake-model/server.js';
import { hostBinaryDir, REAL_HARNESSES, type RealHarness } from './harnesses.js';
import { recordReceipt } from './receipt-report.js';
import { HarnessRun, Probe, type ProbeReceipt } from './session.js';

/**
 * Real harness binaries against a scripted fake model: the harness loads
 * Concord's adapter, runs its hooks and monitors, and takes turns exactly as it
 * would for a user; only the model is replaced, so every run is deterministic.
 *
 * A harness that is not installed is skipped, unless CONCORD_E2E_REAL_HARNESSES
 * names it (or is `all`), as CI does after installing pinned versions.
 */

function required(harness: RealHarness): boolean {
  const wanted = process.env['CONCORD_E2E_REAL_HARNESSES'] ?? '';
  return wanted === 'all' || wanted.split(',').includes(harness.name);
}

const endpointSchema = z
  .object({ promptable: z.boolean(), capabilities: z.array(z.string()) })
  .loose();

/**
 * Wait until the session's turn is over: the model's last step was a final
 * answer, not a tool call, and the harness has not called it again for
 * `quietMs`. A pending tool or a Stop-hook continuation would call the model
 * again within moments, so this is the harness sitting idle at its prompt.
 */
async function untilTurnEnds(model: FakeModel, quietMs: number): Promise<void> {
  let count = model.turns.length;
  let since = Date.now();
  await eventually(
    () => {
      if (model.turns.length !== count) {
        count = model.turns.length;
        since = Date.now();
      }
      const last = model.turns.at(-1);
      return last?.step.kind === 'text' && Date.now() - since >= quietMs ? true : undefined;
    },
    'the session to finish its turn and sit idle',
    90_000,
  );
}

/** Wait for a receipt, recording what was reached even when it never gets there. */
async function receiptReaching(
  probe: Probe,
  row: { harness: string; scenario: string; atSend: string; notes?: string },
  messageId: string,
  wanted: readonly string[],
  timeoutMs = 60_000,
): Promise<ProbeReceipt> {
  try {
    const receipt = await probe.receiptUntil(
      messageId,
      (current) => wanted.includes(current.status),
      `message ${messageId} to reach ${wanted.join(' or ')}`,
      timeoutMs,
    );
    recordReceipt({ ...row, receipt });
    return receipt;
  } catch (error) {
    recordReceipt({ ...row, receipt: await probe.receipt(messageId).catch(() => null) });
    throw error;
  }
}

/** Whether a turn the model saw so far carries this message id. */
function modelSaw(model: FakeModel, messageId: string): boolean {
  return model.turns.some((turn) => turn.conversation.text.includes(`id=${messageId}`));
}

/** Wait for the model to go quiet after a tool call it made. */
async function untilCalled(model: FakeModel, tool: string): Promise<void> {
  await eventually(
    () =>
      model.turns.some((turn) => turn.step.kind === 'tool' && turn.step.name === tool)
        ? true
        : undefined,
    `the model to call ${tool}`,
    60_000,
  );
}

for (const harness of REAL_HARNESSES) {
  const binaryDir = hostBinaryDir(harness.executable);

  describe.skipIf(binaryDir === undefined && !required(harness))(`real ${harness.name}`, () => {
    // Each case's fixtures; anything set up is torn down even if a later step failed.
    let fixtures: { model?: FakeModel; sandbox?: Sandbox; probe?: Probe; runs: HarnessRun[] } = {
      runs: [],
    };

    function ready(): { model: FakeModel; sandbox: Sandbox; probe: Probe } {
      const { model, sandbox, probe } = fixtures;
      if (model === undefined || sandbox === undefined || probe === undefined) {
        throw new Error('The case was not set up.');
      }
      return { model, sandbox, probe };
    }

    beforeEach(async () => {
      fixtures = { runs: [] };
      if (binaryDir === undefined) throw new Error(`${harness.executable} is not installed.`);
      const model = await FakeModel.start();
      fixtures.model = model;
      const sandbox = Sandbox.create(`real-${harness.name}`, inject('concordPrefix'), {
        realHarnesses: [binaryDir],
      });
      fixtures.sandbox = sandbox;
      const setup = await sandbox.concord(['setup'], {
        env: harness.env(model),
        timeoutMs: 120_000,
      });
      expect(setup.status, setup.stderr).toBe(0);
      harness.configure(sandbox, model);
      fixtures.probe = await Probe.start(sandbox);
      onTestFailed(() => {
        for (const run of fixtures.runs)
          console.error(`--- ${harness.name} output ---\n${run.transcript()}`);
        console.error(
          `--- model turns ---\n${model.turns.map((turn) => JSON.stringify(turn.step)).join('\n')}`,
        );
      });
    });

    afterEach(async () => {
      const { model, sandbox, probe, runs } = fixtures;
      try {
        for (const run of runs) run.stop();
        await probe?.close();
      } finally {
        try {
          await model?.close();
        } finally {
          sandbox?.dispose();
        }
      }
    });

    function launch(mode: 'headless' | 'interactive', prompt: string): HarnessRun {
      const { model, sandbox } = ready();
      const run = HarnessRun.start(sandbox, harness, model, mode, prompt);
      fixtures.runs.push(run);
      return run;
    }

    it.skipIf(harness.name === 'goose')(
      'receives a message mid-turn and replies',
      async () => {
        const { model, probe } = ready();
        launch('headless', 'begin, then run sleep 12');
        const agentId = await probe.sessionOf(harness.name);
        await eventually(
          () =>
            model.turns.some((turn) => turn.step.kind === 'tool' && isShell(turn.step.name))
              ? true
              : undefined,
          'the session to start its sleep',
          60_000,
        );

        const body = nonce(`${harness.name}-busy`);
        const sent = await probe.send(agentId, body);
        expect(sent.outlook).toMatch(/only checks between steps/u);

        // Sent is the server's acknowledgement: the result carries the receipt.
        expect(['sent', 'delivered']).toContain(sent.status);
        const answer = await probe.received(
          (message) => message.replyToMessageId === sent.message_id,
          `${agentId} to reply mid-turn`,
        );
        expect(answer).toMatchObject({ senderAgentId: agentId, content: `ACK ${body}` });
        const receipt = await receiptReaching(
          probe,
          { harness: harness.name, scenario: 'busy: reply', atSend: sent.status },
          sent.message_id,
          ['replied'],
        );
        expect(receipt.read_at).not.toBeNull();
      },
      150_000,
    );

    it.skipIf(harness.name === 'goose')(
      'marks a message read mid-turn, with no reply, only once the model was shown it',
      async () => {
        const { model, probe } = ready();
        launch('headless', 'begin, then run sleep 15');
        const agentId = await probe.sessionOf(harness.name);
        await eventually(
          () =>
            model.turns.some((turn) => turn.step.kind === 'tool' && isShell(turn.step.name))
              ? true
              : undefined,
          'the session to start its sleep',
          60_000,
        );

        const sent = await probe.send(agentId, nonce(`${SILENT}${harness.name}-busy`));
        expect(['sent', 'delivered']).toContain(sent.status);
        const receipt = await receiptReaching(
          probe,
          { harness: harness.name, scenario: 'busy: read, no reply', atSend: sent.status },
          sent.message_id,
          ['read'],
          90_000,
        );
        expect(modelSaw(model, sent.message_id)).toBe(true);
        expect(receipt.delivered_at).not.toBeNull();
        expect(receipt.events).toEqual(expect.arrayContaining(['sent', 'delivered', 'read']));
      },
      180_000,
    );

    it.skipIf(harness.idle === 'none')(
      'wakes from idle when a message arrives and replies',
      async () => {
        const { model, probe } = ready();
        launch('interactive', 'begin');
        const agentId = await probe.sessionOf(harness.name);
        await untilTurnEnds(model, 3_000);
        await eventually(
          async () => {
            const view = await probe.inspect(agentId, endpointSchema);
            return view.promptable &&
              (view.capabilities.includes('idle') || view.capabilities.includes('inject'))
              ? true
              : undefined;
          },
          `${agentId} to advertise an idle receiver`,
          60_000,
        );
        const turnsBefore = model.turns.length;

        const body = nonce(`${harness.name}-idle`);
        const sent = await probe.send(agentId, body);
        expect(sent.outlook).toMatch(/arrive on its own|can be injected now|started a new turn/u);

        const answer = await probe.received(
          (message) => message.replyToMessageId === sent.message_id,
          `${agentId} to wake and reply`,
        );
        expect(answer).toMatchObject({ senderAgentId: agentId, content: `ACK ${body}` });
        // The session was woken: the first model call after the send opened a
        // new turn carrying the message, rather than continuing an old one.
        const woken = model.turns[turnsBefore];
        expect(woken?.conversation.opensTurn).toBe(true);
        expect(woken?.conversation.text).toContain(`id=${sent.message_id}`);
        await receiptReaching(
          probe,
          { harness: harness.name, scenario: 'idle: wake and reply', atSend: sent.status },
          sent.message_id,
          ['replied'],
        );
      },
      180_000,
    );

    it.skipIf(harness.idle === 'none')(
      'wakes from idle and marks a message read with no reply',
      async () => {
        const { model, probe } = ready();
        launch('interactive', 'begin');
        const agentId = await probe.sessionOf(harness.name);
        await untilTurnEnds(model, 3_000);
        await eventually(
          async () => {
            const view = await probe.inspect(agentId, endpointSchema);
            return view.promptable &&
              (view.capabilities.includes('idle') || view.capabilities.includes('inject'))
              ? true
              : undefined;
          },
          `${agentId} to advertise an idle receiver`,
          60_000,
        );

        const sent = await probe.send(agentId, nonce(`${SILENT}${harness.name}-idle`));
        const receipt = await receiptReaching(
          probe,
          { harness: harness.name, scenario: 'idle: read, no reply', atSend: sent.status },
          sent.message_id,
          ['read'],
          90_000,
        );
        expect(modelSaw(model, sent.message_id)).toBe(true);
        expect(receipt.delivered_at).not.toBeNull();
      },
      180_000,
    );

    it.skipIf(harness.name !== 'claude-code')(
      'keeps a message delivered, not read, while the agent waits on AskUserQuestion (#208)',
      async () => {
        const { model, probe } = ready();
        const run = launch('interactive', 'begin, then ask the user');
        const agentId = await probe.sessionOf(harness.name);
        await untilCalled(model, 'AskUserQuestion');
        // Let the picker render and the turn block on it.
        await new Promise((resolve) => setTimeout(resolve, 3_000));

        const sent = await probe.send(agentId, nonce(`${SILENT}${harness.name}-held`));
        const row = {
          harness: harness.name,
          scenario: 'blocked on AskUserQuestion',
          atSend: sent.status,
        };
        const delivered = await receiptReaching(
          probe,
          { ...row, notes: 'while the question is open' },
          sent.message_id,
          ['delivered', 'read'],
        );
        expect(delivered.status).toBe('delivered');
        // Held: well past the monitor's poll, still delivered and unseen.
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        const held = await probe.receipt(sent.message_id);
        expect(held.status).toBe('delivered');
        expect(modelSaw(model, sent.message_id)).toBe(false);

        run.type('\r');
        const read = await receiptReaching(
          probe,
          { ...row, notes: 'after the user answered' },
          sent.message_id,
          ['read'],
          90_000,
        );
        expect(modelSaw(model, sent.message_id)).toBe(true);
        expect(['prompt', 'transcript']).toContain(read.readEvidence);
      },
      240_000,
    );

    it.skipIf(harness.name !== 'goose')(
      'queues a message to a session it cannot deliver to, and still sends',
      async () => {
        const { probe } = ready();
        const body = nonce('from-goose');
        launch('headless', `begin, then tell ${probe.agentId}: ${body}`);
        const agentId = await probe.sessionOf(harness.name);

        const received = await probe.received(
          (message) => message.content === body,
          `${agentId} to send its message`,
        );
        expect(received.senderAgentId).toBe(agentId);

        // A Goose session cannot take messages: v2 queues the message as sent
        // instead of failing, and says so, rather than pretending to deliver.
        const queued = await probe.send(agentId, nonce('to-goose'));
        expect(queued.status).toBe('sent');
        expect(queued.outlook).toMatch(/no live session|only checks between steps/u);
        recordReceipt({
          harness: harness.name,
          scenario: 'send to Goose',
          atSend: queued.status,
          receipt: await probe.receipt(queued.message_id),
        });
      },
      150_000,
    );
  });
}
