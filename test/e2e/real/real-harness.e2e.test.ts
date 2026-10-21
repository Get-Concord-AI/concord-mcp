import { afterEach, beforeEach, describe, expect, inject, it, onTestFailed } from 'vitest';
import { z } from 'zod';

import { ToolCallError } from '../support/mcp.js';
import { eventually } from '../support/messages.js';
import { Sandbox } from '../support/sandbox.js';
import { nonce } from '../support/scenario.js';
import { isShell } from './fake-model/brain.js';
import { FakeModel } from './fake-model/server.js';
import { hostBinaryDir, REAL_HARNESSES, type RealHarness } from './harnesses.js';
import { HarnessRun, Probe } from './session.js';

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

        const answer = await probe.received(
          (message) => message.replyToMessageId === sent.message_id,
          `${agentId} to reply mid-turn`,
        );
        expect(answer).toMatchObject({ senderAgentId: agentId, content: `ACK ${body}` });
      },
      150_000,
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
      },
      180_000,
    );

    it.skipIf(harness.name !== 'goose')(
      'refuses a message to a session it cannot deliver to, and still sends',
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

        await expect(probe.send(agentId, nonce('to-goose'))).rejects.toThrow(ToolCallError);
      },
      150_000,
    );
  });
}
