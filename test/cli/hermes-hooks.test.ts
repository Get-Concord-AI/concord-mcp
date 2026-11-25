import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  handleLocalHermesHook,
  hermesHookOutput,
  isHermesHookEvent,
  runHermesHook,
} from '../../src/cli/commands/hermes-hooks.js';
import { workspaceIdForRoot } from '../../src/config/paths.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { agentIdForSession, type AgentIdentity } from '../../src/domain/identity.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

const hookOutput = z.object({ context: z.string() });

function context(output: string): string {
  return hookOutput.parse(JSON.parse(output)).context;
}

const SESSION = 'local-5e55'.padEnd(70, '0');
const HERMES: AgentIdentity = {
  agentId: agentIdForSession('hermes', SESSION),
  kind: 'hermes',
  origin: 'hook',
};
const WORKSPACE = { workspaceId: 'ws_repo', repoRoot: '/repo' };

function payload(firstTurn: boolean, sessionId = SESSION): string {
  return JSON.stringify({
    hook_event_name: 'pre_llm_call',
    session_id: sessionId,
    cwd: '/opt/hermes-agent',
    extra: { is_first_turn: firstTurn, platform: 'cli' },
  });
}

describe('Hermes hook events', () => {
  it('recognises only the event Concord installs', () => {
    expect(isHermesHookEvent('hermes-pre-llm-call')).toBe(true);
    expect(isHermesHookEvent('pre_llm_call')).toBe(false);
    expect(isHermesHookEvent('devin-session-start')).toBe(false);
  });

  it('adds nothing when there is nothing to say', () => {
    expect(hermesHookOutput(undefined, [])).toBe('{}');
  });
});

describe('local Hermes hooks', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('registers the session on its first turn and names both ids, not itself', () => {
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });

    const message = context(handleLocalHermesHook(repos, HERMES, WORKSPACE, true));

    expect(message).toContain(`agent_id: "${HERMES.agentId}"`);
    expect(message).toContain('workspace_id: "ws_repo"');
    expect(message).toContain('codex:peer0001');
    expect(message).not.toContain(`- ${HERMES.agentId}`);
    expect(repos.agents.get(HERMES.agentId)).toBeDefined();
    expect(repos.agentEndpoints.getByAgent(HERMES.agentId)?.status).toBe('connected');
  });

  it('hands a waiting message to the next turn, once, without repeating the ids', () => {
    handleLocalHermesHook(repos, HERMES, WORKSPACE, true);
    handleRegisterAgent(repos, { agent_id: 'codex:peer0001', kind: 'codex' });
    handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'codex:peer0001',
      toAgentId: HERMES.agentId,
      content: 'Reply with PINEAPPLE-42.',
      idempotencyKey: 'k-1',
    });

    const message = context(handleLocalHermesHook(repos, HERMES, WORKSPACE, false));
    expect(message).toContain('PINEAPPLE-42');
    expect(message).not.toContain('workspace_id');
    expect(handleLocalHermesHook(repos, HERMES, WORKSPACE, false)).toBe('{}');
  });
});

describe('runHermesHook', () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'concord-hermes-hook-')));
    project = join(home, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(home, '.hermes'));
    const db = new Database(join(home, '.hermes', 'state.db'));
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)');
    db.prepare('INSERT INTO sessions (id, cwd) VALUES (?, ?)').run(SESSION, project);
    db.close();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("works in the session's recorded project, not the directory Hermes runs hooks from", async () => {
    const output = await runHermesHook('hermes-pre-llm-call', payload(true), {
      HOME: home,
      // Inherited from wherever Hermes was started; the session row wins.
      CLAUDE_CODE_SESSION_ID: 'claude-session',
      CONCORD_REPO_ROOT: home,
    });

    const message = context(output);
    expect(message).toContain(`agent_id: "${HERMES.agentId}"`);
    expect(message).toContain(`workspace_id: "${workspaceIdForRoot(project)}"`);
  });

  it('reads the session store under HERMES_HOME', async () => {
    const profile = join(home, 'profile');
    mkdirSync(profile);
    const empty = await runHermesHook('hermes-pre-llm-call', payload(true), {
      HOME: home,
      HERMES_HOME: profile,
    });
    expect(empty).toBe('{}');
  });

  it('adds nothing for a session Hermes recorded no project for, or no session at all', async () => {
    expect(
      await runHermesHook('hermes-pre-llm-call', payload(true, 'local-unknown'), { HOME: home }),
    ).toBe('{}');
    expect(await runHermesHook('hermes-pre-llm-call', '{}', { HOME: home })).toBe('{}');
  });
});
