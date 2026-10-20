import { describe, expect, it } from 'vitest';

import {
  COPILOT_SERVER_ENV,
  copilotLaunchPlan,
  copilotServerAddress,
  supportsUiServer,
} from '../../src/cli/commands/copilot-adapter.js';

describe('concord adapters copilot (#261)', () => {
  it('starts the TUI with its embedded server and exports the address to hooks', () => {
    const plan = copilotLaunchPlan(47125, ['-i', 'hello'], { PATH: '/bin' });
    expect(plan.args).toEqual(['--ui-server', '--port', '47125', '-i', 'hello']);
    expect(plan.env).toEqual({ PATH: '/bin', [COPILOT_SERVER_ENV]: '127.0.0.1:47125' });
    expect(copilotServerAddress(plan.env)).toBe('127.0.0.1:47125');
  });

  it('leaves plain copilot sessions on hook delivery', () => {
    expect(copilotServerAddress({})).toBeUndefined();
    expect(copilotServerAddress({ [COPILOT_SERVER_ENV]: '  ' })).toBeUndefined();
  });

  it('uses the embedded server only on verified Copilot releases', () => {
    expect(supportsUiServer('GitHub Copilot CLI 1.0.100.')).toBe(true);
    expect(supportsUiServer('GitHub Copilot CLI 1.1.0.')).toBe(true);
    expect(supportsUiServer('GitHub Copilot CLI 1.0.99.')).toBe(false);
    expect(supportsUiServer('not a version')).toBe(false);
  });
});
