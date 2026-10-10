import { describe, expect, it } from 'vitest';

import {
  agentIdForSession,
  resolveActorId,
  resolveIdentity,
  UNRESOLVED_IDENTITY_MESSAGE,
} from '../../src/domain/identity.js';

const SESSION = 'a1b2c3d4-e5f6-7890';

describe('resolveIdentity', () => {
  it('derives identity from the session alone, so a plain session needs no setup', () => {
    const identity = resolveIdentity({ CLAUDE_CODE_SESSION_ID: SESSION });

    expect(identity?.agentId).toMatch(/^claude-code:[0-9a-f]{8}$/);
    expect(identity?.kind).toBe('claude-code');
    expect(identity?.origin).toBe('session');
  });

  it('gives the MCP server and the relay in one session the same id', () => {
    const env = { CLAUDE_CODE_SESSION_ID: SESSION };

    // No kind: the MCP server is told nothing. With a kind: the CLI passes
    // --provider. Both must land on the same agent, or messages bounce.
    expect(resolveIdentity(env)?.agentId).toBe(
      resolveIdentity(env, { kind: 'claude-code' })?.agentId,
    );
  });

  it('prefers an operator-chosen name over the derived slug', () => {
    const identity = resolveIdentity({
      CONCORD_AGENT_ID: 'alpha',
      CLAUDE_CODE_SESSION_ID: SESSION,
    });

    expect(identity?.agentId).toBe('alpha');
    expect(identity?.origin).toBe('operator');
  });

  it('reads a session id a client passes on stdin instead of the environment', () => {
    const identity = resolveIdentity(
      {},
      { kind: 'codex', hookPayload: JSON.stringify({ session_id: SESSION }) },
    );

    expect(identity?.agentId).toBe(agentIdForSession('codex', SESSION));
    expect(identity?.origin).toBe('hook');
  });

  it('derives a Goose identity from the session id Goose exports to extensions', () => {
    const identity = resolveIdentity({ AGENT_SESSION_ID: '20261009_4' });

    expect(identity?.agentId).toBe(agentIdForSession('goose', '20261009_4'));
    expect(identity?.kind).toBe('goose');
  });

  it('never lets one client borrow another client session id', () => {
    // A Codex hook whose payload is missing must not fall through to the Claude
    // Code environment and register codex:<hash of a Claude session>.
    expect(resolveIdentity({ CLAUDE_CODE_SESSION_ID: SESSION }, { kind: 'codex' })).toBeUndefined();
  });

  it('returns undefined rather than inventing an id when nothing identifies the session', () => {
    // An invented id looks registered while being unreachable — the exact
    // failure this module exists to prevent.
    expect(resolveIdentity({})).toBeUndefined();
    expect(resolveIdentity({ CLAUDE_CODE_SESSION_ID: '   ' })).toBeUndefined();
  });

  it('gives different sessions different ids, including ones started in the same second', () => {
    const first = resolveIdentity({
      CLAUDE_CODE_SESSION_ID: '019467a0-0000-7000-8000-000000000001',
    });
    const second = resolveIdentity({
      CLAUDE_CODE_SESSION_ID: '019467a0-0000-7000-8000-000000000002',
    });

    expect(first?.agentId).not.toBe(second?.agentId);
  });
});

describe('resolveActorId', () => {
  const session = {
    agentId: 'claude-code:abcd1234',
    kind: 'claude-code',
    origin: 'session',
  } as const;

  it('uses the resolved session identity', () => {
    expect(resolveActorId(session, undefined)).toBe('claude-code:abcd1234');
  });

  it('ignores a supplied id so an agent cannot act as one of its peers', () => {
    expect(resolveActorId(session, 'claude-code:99999999')).toBe('claude-code:abcd1234');
  });

  it('falls back to a supplied id only where the session is invisible', () => {
    // Codex scrubs the environment of the processes it spawns, so its MCP
    // server cannot see the session; its SessionStart hook tells the model the id.
    expect(resolveActorId(undefined, 'codex:1a2b3c4d')).toBe('codex:1a2b3c4d');
  });

  it('explains how to fix an unidentifiable caller instead of minting an id', () => {
    expect(() => resolveActorId(undefined, undefined)).toThrow(UNRESOLVED_IDENTITY_MESSAGE);
    expect(() => resolveActorId(undefined, '  ')).toThrow(UNRESOLVED_IDENTITY_MESSAGE);
  });
});
