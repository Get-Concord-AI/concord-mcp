import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import {
  handleAcceptHandoff,
  handleDeclineHandoff,
  handleOfferHandoff,
} from '../../src/tools/handoff-lifecycle.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

describe('acknowledged handoff lifecycle', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    for (const agentId of ['codex:from', 'codex:to', 'codex:other']) {
      handleRegisterAgent(repos, { agent_id: agentId, kind: 'codex' });
    }
    handleClaimWork(repos, {
      task_id: 'TASK-1',
      title: 'Transfer work',
      agent_id: 'codex:from',
    });
  });

  it('keeps ownership with the sender until the named recipient accepts', () => {
    const offered = handleOfferHandoff(repos, {
      task_id: 'TASK-1',
      to_agent_id: 'codex:to',
      agent_id: 'codex:from',
      expected_version: 1,
      what_changed: 'implemented parser',
      tests_run: ['pnpm test parser'],
    });
    expect(offered.task.status).toBe('handoff_offered');
    expect(offered.task.agentId).toBe('codex:from');
    expect(offered.task.assignedAgentId).toBe('codex:to');
    expect(offered.handoff.deliveryStatus).toBe('pending');

    const accepted = handleAcceptHandoff(repos, {
      task_id: 'TASK-1',
      handoff_id: offered.handoff.id,
      agent_id: 'codex:to',
      expected_version: 2,
    });
    expect(accepted.handoff.deliveryStatus).toBe('accepted');
    expect(accepted.task.status).toBe('active');
    expect(accepted.task.agentId).toBe('codex:to');
    expect(accepted.task.version).toBe(3);
    expect(repos.ownershipEvents.listByTask('TASK-1').map((event) => event.transition)).toEqual([
      'offer_handoff',
      'accept_handoff',
    ]);
  });

  it('rejects offers by non-owners and acceptance by the wrong recipient', () => {
    expect(() =>
      handleOfferHandoff(repos, {
        task_id: 'TASK-1',
        to_agent_id: 'codex:to',
        agent_id: 'codex:other',
        expected_version: 1,
        what_changed: 'not mine',
      }),
    ).toThrow(/current owner/u);

    const offered = handleOfferHandoff(repos, {
      task_id: 'TASK-1',
      to_agent_id: 'codex:to',
      agent_id: 'codex:from',
      expected_version: 1,
      what_changed: 'ready',
    });
    expect(() =>
      handleAcceptHandoff(repos, {
        task_id: 'TASK-1',
        handoff_id: offered.handoff.id,
        agent_id: 'codex:other',
        expected_version: 2,
      }),
    ).toThrow(/not addressed/u);
  });

  it('declines back to the sender and prevents a later acceptance', () => {
    const offered = handleOfferHandoff(repos, {
      task_id: 'TASK-1',
      to_agent_id: 'codex:to',
      agent_id: 'codex:from',
      expected_version: 1,
      what_changed: 'ready',
    });
    const declined = handleDeclineHandoff(repos, {
      task_id: 'TASK-1',
      handoff_id: offered.handoff.id,
      agent_id: 'codex:to',
      expected_version: 2,
      reason: 'no capacity',
    });
    expect(declined.handoff.deliveryStatus).toBe('declined');
    expect(declined.task.agentId).toBe('codex:from');
    expect(declined.ownershipEvent.reason).toBe('no capacity');

    expect(() =>
      handleAcceptHandoff(repos, {
        task_id: 'TASK-1',
        handoff_id: offered.handoff.id,
        agent_id: 'codex:to',
        expected_version: 3,
      }),
    ).toThrow(/Pending handoff/u);
  });

  it('expires a pending offer and restores the sender', () => {
    const offered = handleOfferHandoff(
      repos,
      {
        task_id: 'TASK-1',
        to_agent_id: 'codex:to',
        agent_id: 'codex:from',
        expected_version: 1,
        what_changed: 'ready briefly',
        expires_seconds: 1,
      },
      1_000,
    );
    const expired = handleAcceptHandoff(
      repos,
      {
        task_id: 'TASK-1',
        handoff_id: offered.handoff.id,
        agent_id: 'codex:to',
        expected_version: 2,
      },
      2_000,
    );

    expect(expired.handoff.deliveryStatus).toBe('expired');
    expect(expired.task.status).toBe('active');
    expect(expired.task.agentId).toBe('codex:from');
    expect(expired.ownershipEvent.transition).toBe('expire_handoff');
  });

  it('allows only one resolution for a pending handoff version', () => {
    const offered = handleOfferHandoff(repos, {
      task_id: 'TASK-1',
      to_agent_id: 'codex:to',
      agent_id: 'codex:from',
      expected_version: 1,
      what_changed: 'ready',
    });
    handleAcceptHandoff(repos, {
      task_id: 'TASK-1',
      handoff_id: offered.handoff.id,
      agent_id: 'codex:to',
      expected_version: 2,
    });

    expect(() =>
      handleDeclineHandoff(repos, {
        task_id: 'TASK-1',
        handoff_id: offered.handoff.id,
        agent_id: 'codex:to',
        expected_version: 2,
        reason: 'too late',
      }),
    ).toThrow(/version conflict/u);
  });
});
