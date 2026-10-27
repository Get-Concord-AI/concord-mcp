import { describe, expect, it } from 'vitest';
import { z } from 'zod';

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

  it('touches only the root hooks object, never a nested key of the same name', () => {
    const nested = { mcpServers: { hooks: { command: 'my-hook-server' } } };
    const installed = upsertDevinUserHooksConfig(JSON.stringify(nested));
    const parsed = z
      .object({
        mcpServers: z.object({ hooks: z.object({ command: z.string() }) }),
        hooks: z.record(z.string(), z.array(z.unknown())),
      })
      .parse(JSON.parse(installed));

    expect(parsed.mcpServers.hooks).toEqual({ command: 'my-hook-server' });
    expect(Object.keys(parsed.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'SessionEnd']);
    expect(JSON.parse(removeDevinUserHooksConfig(installed))).toEqual(nested);

    const both = JSON.stringify({
      mcpServers: { hooks: { command: 'my-hook-server' } },
      hooks: { Stop: [] },
    });
    const merged = upsertDevinUserHooksConfig(both);
    expect(merged).toContain('{"command":"my-hook-server"}');
    expect(merged).toContain('concord hook devin-session-start');
    expect(JSON.parse(removeDevinUserHooksConfig(merged))).toEqual(JSON.parse(both));
  });
});
