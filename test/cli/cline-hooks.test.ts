import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  clineSurface,
  clineWorkspace,
  handleLocalClineHook,
  isClineHookEvent,
  runClineHook,
} from '../../src/cli/commands/cline-hooks.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { agentIdForSession, type AgentIdentity } from '../../src/domain/identity.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

const TASK_START_PAYLOAD = JSON.stringify({
  taskId: 'cline-task-1',
  hookName: 'TaskStart',
  workspaceRoots: ['/work/app'],
  cwd: '/work/app',
});

const CLINE: AgentIdentity = {
  agentId: agentIdForSession('cline', 'cline-task-1'),
  kind: 'cline',
  origin: 'hook',
};

const CONTEXT = { repoRoot: '/work/app', workspaceId: 'ws_test' };

describe('Cline hook events', () => {
  it('recognises only the events Concord installs', () => {
    expect(isClineHookEvent('cline-task-start')).toBe(true);
    expect(isClineHookEvent('cline-task-resume')).toBe(true);
    expect(isClineHookEvent('cline-user-prompt-submit')).toBe(true);
    expect(isClineHookEvent('cline-task-cancel')).toBe(false);
    expect(isClineHookEvent('kiro-session-start')).toBe(false);
  });

  it("reads the workspace from the payload's workspace roots before cwd", () => {
    expect(clineWorkspace(TASK_START_PAYLOAD)).toBe('/work/app');
    expect(clineWorkspace(JSON.stringify({ cwd: '/elsewhere' }))).toBe('/elsewhere');
    expect(clineWorkspace('{}')).toBe(process.cwd());
    expect(clineWorkspace('{ not json')).toBe(process.cwd());
    expect(clineWorkspace(JSON.stringify({ workspaceRoots: ['', '/first'] }))).toBe('/first');
  });

  it('tells the extension surface from the SDK surface by hook name', () => {
    expect(clineSurface({ hookName: 'TaskStart' })).toBe('extension');
    expect(clineSurface({ hookName: 'UserPromptSubmit' })).toBe('extension');
    expect(clineSurface({ hook_name: 'prompt_submit' })).toBe('sdk');
    expect(clineSurface({ hookName: 'agent_start' })).toBe('sdk');
    expect(clineSurface({})).toBe('unknown');
  });
});

describe('local Cline hooks', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('registers the task identity and names agent_id and workspace_id on task start', () => {
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });

    const output = handleLocalClineHook(
      repos,
      CLINE,
      CONTEXT,
      'cline-task-start',
      'extension',
    );

    const control = z
      .object({ contextModification: z.string().optional() })
      .loose()
      .parse(JSON.parse(output));
    const message = control.contextModification ?? '';
    expect(message).toContain(`agent \`${CLINE.agentId}\``);
    expect(message).toContain('agent_id: "cline:');
    expect(message).toContain('workspace_id: "ws_test"');
    expect(message).toContain('codex:peer0001');
    expect(message).not.toContain(`- ${CLINE.agentId}`);
    expect(message).toContain('does not wake an idle session');
    expect(repos.agentEndpoints.getByAgent(CLINE.agentId)).toBeDefined();
  });

  it('injects a waiting message on the extension prompt submit, once', () => {
    handleLocalClineHook(repos, CLINE, CONTEXT, 'cline-task-start', 'extension');
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });
    handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'codex:peer0001',
      toAgentId: CLINE.agentId,
      content: 'Reply with PINEAPPLE-42.',
      idempotencyKey: 'c-1',
    });

    const first = handleLocalClineHook(
      repos,
      CLINE,
      CONTEXT,
      'cline-user-prompt-submit',
      'extension',
    );
    expect(first).toContain('PINEAPPLE-42');
    expect(z.object({ contextModification: z.string() }).loose().parse(JSON.parse(first))).toHaveProperty('contextModification');

    const second = handleLocalClineHook(
      repos,
      CLINE,
      CONTEXT,
      'cline-user-prompt-submit',
      'extension',
    );
    expect(second).toBe('{}');
  });

  it('does not drain on the SDK surface, where hook output never reaches the model', () => {
    handleLocalClineHook(repos, CLINE, CONTEXT, 'cline-task-start', 'sdk');
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });
    handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'codex:peer0001',
      toAgentId: CLINE.agentId,
      content: 'Reply with PINEAPPLE-42.',
      idempotencyKey: 'c-2',
    });

    // A pending-count notice, never the message body and never a claim.
    for (const surface of ['sdk', 'unknown'] as const) {
      const output = handleLocalClineHook(
        repos,
        CLINE,
        CONTEXT,
        'cline-user-prompt-submit',
        surface,
      );
      expect(output).toContain('inbox drain');
      expect(output).not.toContain('PINEAPPLE-42');
    }

    // The message is still waiting for a manual drain, not lost.
    expect(
      handleLocalClineHook(repos, CLINE, CONTEXT, 'cline-user-prompt-submit', 'extension'),
    ).toContain('PINEAPPLE-42');
  });

  it('keeps a stable identity across task start and prompt submit for the same task', () => {
    const start = handleLocalClineHook(
      repos,
      CLINE,
      CONTEXT,
      'cline-task-start',
      'extension',
    );
    expect(start).toContain(CLINE.agentId);
    expect(repos.agents.get(CLINE.agentId)).toBeDefined();
  });
});

describe('runClineHook end to end', () => {
  it('derives the cline identity from task_id and resolves the payload workspace', async () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cline-hook-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'concord-cline-hook-ws-'));
    mkdirSync(join(workspace, '.git'), { recursive: true });
    const env = { HOME: home, USERPROFILE: home };
    const payload = JSON.stringify({
      task_id: 'task-xyz',
      hook_name: 'agent_start',
      workspace_roots: [workspace],
    });

    const output = await runClineHook('cline-task-start', payload, env);
    const control = z
      .object({ contextModification: z.string().optional() })
      .loose()
      .parse(JSON.parse(output));
    const message = control.contextModification ?? '';
    expect(message).toContain(agentIdForSession('cline', 'task-xyz'));
    expect(message).toContain('workspace_id: "ws_');
  });

  it('honours CONCORD_AGENT_ID over the task-derived identity', async () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cline-hook-env-'));
    const workspace = mkdtempSync(join(tmpdir(), 'concord-cline-hook-ws2-'));
    mkdirSync(join(workspace, '.git'), { recursive: true });
    const env = { HOME: home, USERPROFILE: home, CONCORD_AGENT_ID: 'cline:operator' };
    const payload = JSON.stringify({
      taskId: 'task-abc',
      hookName: 'TaskStart',
      workspaceRoots: [workspace],
    });

    const output = await runClineHook('cline-task-start', payload, env);
    expect(output).toContain('cline:operator');
    expect(output).not.toContain(agentIdForSession('cline', 'task-abc'));
  });

  it('reports an unresolved identity without failing the hook', async () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-cline-hook-none-'));
    const workspace = mkdtempSync(join(tmpdir(), 'concord-cline-hook-ws3-'));
    mkdirSync(join(workspace, '.git'), { recursive: true });
    const env = { HOME: home, USERPROFILE: home };
    const payload = JSON.stringify({ hookName: 'TaskStart', workspaceRoots: [workspace] });

    const output = await runClineHook('cline-task-start', payload, env);
    expect(output).toContain('contextModification');
    expect(output).toContain('Concord cannot tell which session');

    const prompt = await runClineHook(
      'cline-user-prompt-submit',
      JSON.stringify({ hookName: 'UserPromptSubmit', workspaceRoots: [workspace] }),
      env,
    );
    expect(prompt).toBe('{}');
  });
});
