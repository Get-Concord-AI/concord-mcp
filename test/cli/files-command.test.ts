import { describe, expect, it } from 'vitest';

import { retrievingAgentId } from '../../src/cli/commands/files.js';

describe('retrievingAgentId', () => {
  it('refuses to act as another agent while this session is visible', () => {
    expect(() => retrievingAgentId('agent-alpha', { CONCORD_AGENT_ID: 'agent-beta' })).toThrow(
      'This session is agent agent-beta',
    );
  });

  it('acts as the session agent when none is named', () => {
    expect(retrievingAgentId(undefined, { CONCORD_AGENT_ID: 'agent-beta' })).toBe('agent-beta');
  });

  it('trusts the named agent where no session is visible', () => {
    expect(retrievingAgentId('agent-alpha', {})).toBe('agent-alpha');
  });
});
