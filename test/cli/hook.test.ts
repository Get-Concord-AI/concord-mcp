import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  antigravityWorkspace,
  decidePreToolUse,
  devinPromptSubmitOutput,
  handleAntigravityPreInvocation,
  handleAntigravitySessionStart,
  handleAntigravityStop,
  handleSessionStart,
  sessionStartIdentity,
} from '../../src/cli/commands/hook.js';
import { registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { openDatabase } from '../../src/db/connection.js';
import { monitorCapabilityFor } from '../../src/domain/delivery.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';

function preToolUse(filePath: string): string {
  return JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } });
}

describe('decidePreToolUse', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('allows edits to files no other task has claimed', () => {
    handleClaimWork(repos, { task_id: 'T1', title: 'Other', expected_files: ['src/a.ts'] });
    const decision = decidePreToolUse(repos, preToolUse('src/b.ts'), 'MINE');
    expect(decision.block).toBe(false);
    expect(decision.message).toBe('');
  });

  it('blocks an edit to a file claimed by another active task', () => {
    handleClaimWork(repos, { task_id: 'OTHER', title: 'Owns app', expected_files: ['src/app.ts'] });
    const decision = decidePreToolUse(repos, preToolUse('src/app.ts'), 'MINE');
    expect(decision.block).toBe(true);
    expect(decision.message).toContain('OTHER');
  });

  it('does not block your own claimed file when CONCORD_TASK matches', () => {
    handleClaimWork(repos, { task_id: 'MINE', title: 'Mine', expected_files: ['src/app.ts'] });
    expect(decidePreToolUse(repos, preToolUse('src/app.ts'), 'MINE').block).toBe(false);
  });

  it('advises but does not block when the task id is unknown', () => {
    handleClaimWork(repos, { task_id: 'OTHER', title: 'Owns', expected_files: ['src/app.ts'] });
    const decision = decidePreToolUse(repos, preToolUse('src/app.ts'), undefined);
    expect(decision.block).toBe(false);
    expect(decision.message).toContain('CONCORD_TASK');
  });

  it('allows when there is no file path or the payload is malformed', () => {
    handleClaimWork(repos, { task_id: 'OTHER', title: 'Owns', expected_files: ['src/app.ts'] });
    expect(
      decidePreToolUse(repos, JSON.stringify({ tool_name: 'Bash', tool_input: {} }), 'MINE').block,
    ).toBe(false);
    expect(decidePreToolUse(repos, 'not valid json', 'MINE').block).toBe(false);
  });
});

describe('sessionStartIdentity', () => {
  it('derives a stable id from the session id', () => {
    const id = sessionStartIdentity('a1b2c3d4-e5f6-7890', {})?.agentId;

    expect(id).toMatch(/^claude-code:[0-9a-f]{8}$/);
    expect(sessionStartIdentity('a1b2c3d4-e5f6-7890', {})?.agentId).toBe(id);
  });

  it('separates sessions that share a leading timestamp', () => {
    expect(sessionStartIdentity('019fd3d0-aaaa-7211-b743-000000000001', {})?.agentId).not.toBe(
      sessionStartIdentity('019fd3d0-bbbb-7211-b743-000000000002', {})?.agentId,
    );
  });

  it('invents nothing when no session id is given', () => {
    // A random suffix here would produce an agent the relay never registers an
    // endpoint for: addressable, and permanently undeliverable.
    expect(sessionStartIdentity(undefined, {})).toBeUndefined();
  });
});

describe('handleSessionStart', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('registers the session as an agent and reports its id', () => {
    const result = handleSessionStart(
      repos,
      JSON.stringify({ session_id: 'a1b2c3d4-e5f6', cwd: '/repo' }),
    );
    expect(result.agentId).toMatch(/^claude-code:[0-9a-f]{8}$/);
    expect(result.message).toContain(result.agentId);
    expect(result.message).toContain('start_work, update_work, finish_work');
    expect(result.message).not.toContain('claim_work');
    expect(result.message).toContain('No other agents');
    expect(repos.agents.get(result.agentId ?? '')?.cwd).toBe('/repo');
  });

  it('is idempotent for the same session and lists other present agents', () => {
    handleRegisterAgent(repos, {
      agent_id: 'codex:9q2r',
      kind: 'codex',
      summary: 'building the backend',
    });
    const payload = JSON.stringify({ session_id: 'a1b2c3d4' });
    handleSessionStart(repos, payload);
    const again = handleSessionStart(repos, payload);
    expect(repos.agents.list()).toHaveLength(2);
    expect(again.message).toContain('codex:9q2r');
    expect(again.message).toContain('building the backend');
  });

  it('falls back to the environment when the payload is malformed', () => {
    const result = handleSessionStart(repos, 'not json', {
      CLAUDE_CODE_SESSION_ID: 'a1b2c3d4-e5f6-7890',
    });

    expect(result.agentId).toMatch(/^claude-code:[0-9a-f]{8}$/);
  });

  it('registers nothing when a malformed payload has no environment to fall back on', () => {
    // Generating an id here would create an agent the relay never registers an
    // endpoint for: addressable by peers, and permanently undeliverable.
    const result = handleSessionStart(repos, 'not json', {});

    expect(result.agentId).toBeUndefined();
    expect(result.message).toContain('concord inbox register');
    expect(repos.agents.list()).toHaveLength(0);
  });
});

describe('Antigravity hook handlers', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  const injectStepsSchema = z.object({
    injectSteps: z.array(
      z.object({
        ephemeralMessage: z.string().optional(),
        systemMessage: z.string().optional(),
        userMessage: z.string().optional(),
      }),
    ),
  });

  const stopSchema = z.object({
    decision: z.string().optional(),
    reason: z.string().optional(),
  });

  describe('handleAntigravitySessionStart', () => {
    it('registers the agent and returns persistent system message with agent id', () => {
      const payload = JSON.stringify({ conversationId: 'conv-test-123' });
      const result = handleAntigravitySessionStart(repos, payload);

      expect(result.agentId).toMatch(/^antigravity:[0-9a-f]{8}$/);
      if (result.agentId === undefined) {
        throw new Error('expected agentId to be defined');
      }
      expect(repos.agents.get(result.agentId)).toBeDefined();
      expect(repos.agentEndpoints.getByAgent(result.agentId)).toBeDefined();

      const output = injectStepsSchema.parse(JSON.parse(result.output));
      expect(output.injectSteps).toHaveLength(1);
      expect(output.injectSteps[0]?.systemMessage).toContain(result.agentId);
      expect(output.injectSteps[0]?.systemMessage).toContain('agent_id');
      expect(output.injectSteps[0]?.systemMessage).toContain('cannot see your session');
      expect(output.injectSteps[0]?.systemMessage).toContain(
        'write call (start_work, update_work, transfer_work, finish_work)',
      );
      expect(output.injectSteps[0]?.systemMessage).not.toContain('inspect_work');
    });

    it('tells the agent to start its idle monitor with its own id filled in', () => {
      const payload = JSON.stringify({ conversationId: 'conv-test-123' });
      const result = handleAntigravitySessionStart(repos, payload);
      const message =
        injectStepsSchema.parse(JSON.parse(result.output)).injectSteps[0]?.systemMessage ?? '';

      expect(message).toContain(
        `\`concord inbox watch --agent ${result.agentId ?? ''} --provider antigravity --once\``,
      );
      expect(message).toContain('background command');
      expect(message).not.toContain('never need to poll');
    });

    it('returns error message when conversationId is missing', () => {
      const result = handleAntigravitySessionStart(repos, '{}');
      expect(result.agentId).toBeUndefined();
      const output = injectStepsSchema.parse(JSON.parse(result.output));
      expect(output.injectSteps[0]?.ephemeralMessage).toContain(
        'Concord cannot tell which session you are',
      );
    });
  });

  describe('handleAntigravityPreInvocation', () => {
    it('asks for the idle monitor on the first model call while none is watching', () => {
      const payload = JSON.stringify({ conversationId: 'conv-test-123', invocationNum: 0 });
      const start = handleAntigravitySessionStart(repos, payload);
      const result = handleAntigravityPreInvocation(repos, payload);
      const steps = injectStepsSchema.parse(JSON.parse(result.output)).injectSteps;
      expect(steps).toHaveLength(1);
      expect(steps[0]?.userMessage).toContain(
        `concord inbox watch --agent ${start.agentId ?? ''} --provider antigravity --once`,
      );
    });

    it('does not ask for the monitor while one holds the receiver', () => {
      const payload = JSON.stringify({ conversationId: 'conv-test-123', invocationNum: 0 });
      const start = handleAntigravitySessionStart(repos, payload);
      const agentId = start.agentId ?? '';
      registerPullEndpoint(
        repos,
        agentId,
        'antigravity',
        Date.now(),
        monitorCapabilityFor('antigravity'),
      );
      const endpoint = repos.agentEndpoints.getByAgent(agentId);
      if (endpoint === undefined) throw new Error('expected an endpoint');
      repos.agentEndpoints.heartbeatReceiver(
        endpoint.endpointId,
        new Date(Date.now() + 60_000).toISOString(),
      );

      const result = handleAntigravityPreInvocation(repos, payload);
      expect(injectStepsSchema.parse(JSON.parse(result.output))).toEqual({ injectSteps: [] });
    });

    it('returns empty injectSteps when no messages are pending', () => {
      const payload = JSON.stringify({ conversationId: 'conv-test-123' });
      const result = handleAntigravityPreInvocation(repos, payload);
      expect(injectStepsSchema.parse(JSON.parse(result.output))).toEqual({ injectSteps: [] });
    });

    it('drains pending inbox messages and injects them as userMessage', () => {
      const payload = JSON.stringify({ conversationId: 'conv-test-123' });
      const start = handleAntigravitySessionStart(repos, payload);
      if (start.agentId === undefined) {
        throw new Error('expected agentId to be defined');
      }
      const recipientId = start.agentId;

      handleRegisterAgent(repos, { agent_id: 'claude:sender', kind: 'claude-code' });
      handleSendAgentMessage(repos, {
        operation: 'prompt',
        agentId: 'claude:sender',
        toAgentId: recipientId,
        content: 'Review the latest diff please.',
        idempotencyKey: 'k-1',
      });

      const result = handleAntigravityPreInvocation(repos, payload);
      const parsed = injectStepsSchema.parse(JSON.parse(result.output));
      expect(parsed.injectSteps).toHaveLength(1);
      expect(parsed.injectSteps[0]?.userMessage).toContain('Review the latest diff please.');
      expect(parsed.injectSteps[0]?.userMessage).toContain('claude:sender');

      // Subsequent call should have no more pending messages
      const secondResult = handleAntigravityPreInvocation(repos, payload);
      expect(injectStepsSchema.parse(JSON.parse(secondResult.output))).toEqual({ injectSteps: [] });
    });
  });

  describe('handleAntigravityStop', () => {
    it('returns empty object when no messages are pending at stop', () => {
      const payload = JSON.stringify({ conversationId: 'conv-test-123' });
      const result = handleAntigravityStop(repos, payload);
      expect(stopSchema.parse(JSON.parse(result.output))).toEqual({});
    });

    it('continues turn with reason when new messages arrived before stop', () => {
      const payload = JSON.stringify({ conversationId: 'conv-test-123' });
      const start = handleAntigravitySessionStart(repos, payload);
      if (start.agentId === undefined) {
        throw new Error('expected agentId to be defined');
      }
      const recipientId = start.agentId;

      handleRegisterAgent(repos, { agent_id: 'claude:sender', kind: 'claude-code' });
      handleSendAgentMessage(repos, {
        operation: 'prompt',
        agentId: 'claude:sender',
        toAgentId: recipientId,
        content: 'Wait, one more thing!',
        idempotencyKey: 'k-2',
      });

      const result = handleAntigravityStop(repos, payload);
      const parsed = stopSchema.parse(JSON.parse(result.output));
      expect(parsed.decision).toBe('continue');
      expect(parsed.reason).toContain('Wait, one more thing!');
    });
  });
});

describe('antigravityWorkspace', () => {
  it('extracts first workspacePath from payload', () => {
    const payload = JSON.stringify({
      conversationId: 'conv-1',
      workspacePaths: ['/home/user/project', '/other'],
    });
    expect(antigravityWorkspace(payload)).toBe('/home/user/project');
  });

  it('falls back to cwd when workspacePaths is absent', () => {
    const payload = JSON.stringify({ conversationId: 'conv-1' });
    expect(antigravityWorkspace(payload)).toBe(process.cwd());
  });

  it('falls back to cwd when workspacePaths is empty', () => {
    const payload = JSON.stringify({ conversationId: 'conv-1', workspacePaths: [] });
    expect(antigravityWorkspace(payload)).toBe(process.cwd());
  });

  it('falls back to cwd on invalid JSON', () => {
    expect(antigravityWorkspace('{ not json')).toBe(process.cwd());
  });

  it('falls back to cwd on empty input', () => {
    expect(antigravityWorkspace('')).toBe(process.cwd());
  });
});

describe('devinPromptSubmitOutput', () => {
  it('adds no context when the inbox is empty, since Devin rejects an empty block', () => {
    expect(devinPromptSubmitOutput([])).toBe('{}');
  });

  it('injects drained messages as UserPromptSubmit context', () => {
    const output = z
      .object({
        hookSpecificOutput: z.object({
          hookEventName: z.literal('UserPromptSubmit'),
          additionalContext: z.string(),
        }),
      })
      .parse(
        JSON.parse(
          devinPromptSubmitOutput([
            {
              messageId: 'm1',
              senderAgentId: 'codex:peer',
              taskId: null,
              content: 'PINEAPPLE-42',
              messageKind: 'prompt',
              deliveryLatencyMs: null,
            },
          ]),
        ),
      );
    expect(output.hookSpecificOutput.additionalContext).toContain('PINEAPPLE-42');
  });
});
