import { describe, expect, it } from 'vitest';

import { resolveSessionBoundAgent } from '../../src/cli/agent-identity.js';

const action = 'save files shared with';

describe('files get agent check', () => {
  it('refuses to act as another agent while this session is visible', () => {
    expect(() =>
      resolveSessionBoundAgent('agent-alpha', { CONCORD_AGENT_ID: 'agent-beta' }, {}, action),
    ).toThrow('This session is agent agent-beta; it cannot save files shared with agent-alpha.');
  });

  it('acts as the session agent when none is named', () => {
    expect(
      resolveSessionBoundAgent(undefined, { CONCORD_AGENT_ID: 'agent-beta' }, {}, action),
    ).toBe('agent-beta');
  });

  it('trusts the named agent where no session is visible', () => {
    expect(resolveSessionBoundAgent('agent-alpha', {}, {}, action)).toBe('agent-alpha');
  });
});
