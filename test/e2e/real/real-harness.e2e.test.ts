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

/** Wait until the model has had no new turn for `quietMs`: the session is idle. */
async function untilQuiet(model: FakeModel, quietMs: number): Promise<void> {
  let count = model.turns.length;
  let since = Date.now();
  await eventually(
    () => {
      if (model.turns.length !== count) {
        count = model.turns.length;
        since = Date.now();
      }
      return model.turns.length > 0 && Date.now() - since >= quietMs ? true : undefined;
    },
    'the session to go idle',
    90_000,
  );
}

for (const harness of REAL_HARNESSES) {
  const binaryDir = hostBinaryDir(harness.executable);

  describe.skipIf(binaryDir === undefined && !required(harness))(`real ${harness.name}`, () => {
    let sandbox: Sandbox;
    let model: FakeModel;
    let probe: Probe;
    const runs: HarnessRun[] = [];

    beforeEach(async () => {
      if (binaryDir === undefined) throw new Error(`${harness.executable} is not installed.`);
      model = await FakeModel.start();
      sandbox = Sandbox.create(`real-${harness.name}`, inject('concordPrefix'), {
        realHarnesses: [binaryDir],
      });
      const setup = await sandbox.concord(['setup'], {
        env: harness.env(model),
        timeoutMs: 120_000,
      });
      expect(setup.status, setup.stderr).toBe(0);
      harness.configure(sandbox, model);
      probe = await Probe.start(sandbox);
      onTestFailed(() => {
        for (const run of runs)
          console.error(`--- ${harness.name} output ---\n${run.transcript()}`);
        console.error(
          `--- model turns ---\n${model.turns.map((turn) => JSON.stringify(turn.step)).join('\n')}`,
        );
      });
    });

    afterEach(async () => {
      for (const run of runs.splice(0)) run.stop();
      await probe.close();
      await model.close();
      sandbox.dispose();
    });

    function launch(mode: 'headless' | 'interactive', prompt: string): HarnessRun {
      const run = HarnessRun.start(sandbox, harness, model, mode, prompt);
      runs.push(run);
      return run;
    }

    it.skipIf(harness.name === 'goose')(
      'receives a message mid-turn and replies',
      async () => {
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
        launch('interactive', 'begin');
        const agentId = await probe.sessionOf(harness.name);
        await untilQuiet(model, 3_000);
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
        // The reply came from a turn the message itself started.
        expect(model.turns.length).toBeGreaterThan(turnsBefore);
      },
      180_000,
    );

    it.skipIf(harness.name !== 'goose')(
      'refuses a message to a session it cannot deliver to, and still sends',
      async () => {
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
