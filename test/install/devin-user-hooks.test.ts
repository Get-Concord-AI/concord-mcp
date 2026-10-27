import { describe, expect, it } from 'vitest';

import {
  removeDevinUserHooksConfig,
  upsertDevinUserHooksConfig,
} from '../../src/install/devin-user-hooks.js';

describe('Devin user hooks config', () => {
  it('merges idempotently and preserves user settings and hooks', () => {
    const original =
      '{\n  // Keep this user setting\n  "theme_mode": "dark",\n  "hooks": {\n    "PreToolUse": [{ "matcher": "exec", "hooks": [{ "type": "command", "command": "echo user" }] }]\n  }\n}\n';
    const installed = upsertDevinUserHooksConfig(original);

    expect(installed).toContain('// Keep this user setting');
    expect(installed).toContain('"theme_mode": "dark"');
    expect(installed).toContain('echo user');
    expect(installed).toContain('concord hook devin-user-prompt-submit');
    expect(upsertDevinUserHooksConfig(installed)).toBe(installed);
    expect(removeDevinUserHooksConfig(installed)).toContain('echo user');
  });

  it('preserves comments inside the hooks object through install and removal', () => {
    const original = `{
  "hooks": {
    // Explains the user's hook
    "PreToolUse": [{ "matcher": "exec", "hooks": [{ "type": "command", "command": "echo user" }] }]
  }
}
`;
    const installed = upsertDevinUserHooksConfig(original);
    expect(installed).toContain("// Explains the user's hook");
    expect(removeDevinUserHooksConfig(installed)).toContain("// Explains the user's hook");
  });

  it('parses escaped Windows paths in the config', () => {
    const source = JSON.stringify({
      working_directory: 'C:\\Users\\test\\',
    });
    const installed = upsertDevinUserHooksConfig(source);

    expect(JSON.parse(installed)).toMatchObject({ working_directory: 'C:\\Users\\test\\' });
  });

  it('removes only Concord commands from entries that also contain user hooks', () => {
    const source = JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'echo user' },
              { type: 'command', command: 'concord hook devin-user-prompt-submit' },
            ],
          },
        ],
      },
    });
    const removed = removeDevinUserHooksConfig(source);

    expect(JSON.parse(removed)).toMatchObject({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo user' }] }],
      },
    });
  });
});
