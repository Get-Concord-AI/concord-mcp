import { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';

import {
  codexAppServerConfigArgs,
  codexLaunchArgv,
  codexManagedEnvironment,
  codexManagedLaunchContext,
  registerAdaptersCommand,
} from '../../src/cli/commands/adapters.js';

describe('Codex managed launcher', () => {
  it('passes the app-server URL to every managed child process', () => {
    const input = { PATH: '/test/bin', USER_SETTING: 'preserved' };

    expect(codexManagedEnvironment('ws://127.0.0.1:43210', input)).toEqual({
      PATH: '/test/bin',
      USER_SETTING: 'preserved',
      CONCORD_CODEX_APP_SERVER_URL: 'ws://127.0.0.1:43210',
    });
    expect(input).not.toHaveProperty('CONCORD_CODEX_APP_SERVER_URL');
  });

  it('runs the app-server and TUI from the resolved repository root', () => {
    expect(
      codexManagedLaunchContext('/repos/talking-test', 'ws://127.0.0.1:43210', {
        PATH: '/test/bin',
      }),
    ).toEqual({
      cwd: '/repos/talking-test',
      env: {
        PATH: '/test/bin',
        CONCORD_CODEX_APP_SERVER_URL: 'ws://127.0.0.1:43210',
      },
    });
  });
});

describe('codexAppServerConfigArgs (#269)', () => {
  it('forwards -c/--config with their values', () => {
    expect(
      codexAppServerConfigArgs([
        '-c',
        'model_provider=fake',
        '-c',
        'model_providers.fake={}',
        '--config',
        'model=fake-model',
        '--profile',
        'ci',
        '--model',
        'fake-model',
        '--dangerously-bypass-approvals-and-sandbox',
        'hello',
      ]),
    ).toEqual([
      '-c',
      'model_provider=fake',
      '-c',
      'model_providers.fake={}',
      '--config',
      'model=fake-model',
    ]);
  });

  it('forwards attached = forms of -c/--config only', () => {
    expect(
      codexAppServerConfigArgs([
        '--config=model_provider=fake',
        '-c=model=fake-model',
        '--profile=ci',
        '-m=gpt-test',
        'prompt text',
      ]),
    ).toEqual(['--config=model_provider=fake', '-c=model=fake-model']);
  });

  it('leaves --profile, model flags, TUI-only flags, and free text out', () => {
    expect(
      codexAppServerConfigArgs([
        '--profile',
        'ci',
        '-m',
        'gpt-test',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        'do the thing',
      ]),
    ).toEqual([]);
  });
});

describe('codexLaunchArgv (#269)', () => {
  it('puts -c overrides on app-server and keeps the full argv on the TUI', () => {
    const args = [
      '-c',
      'model_provider=fake',
      '--profile',
      'ci',
      '--dangerously-bypass-approvals-and-sandbox',
      'hi',
    ];
    expect(codexLaunchArgv('ws://127.0.0.1:9', args)).toEqual({
      appServer: ['app-server', '--listen', 'ws://127.0.0.1:9', '-c', 'model_provider=fake'],
      tui: ['--remote', 'ws://127.0.0.1:9', ...args],
    });
  });

  it('keeps --profile and TUI-only flags on the remote TUI only', () => {
    const args = [
      '--profile',
      'ci',
      '--dangerously-bypass-approvals-and-sandbox',
      '--sandbox',
      'danger-full-access',
      'prompt',
    ];
    const argv = codexLaunchArgv('ws://127.0.0.1:9', args);
    expect(argv.appServer).toEqual(['app-server', '--listen', 'ws://127.0.0.1:9']);
    expect(argv.tui).toEqual(['--remote', 'ws://127.0.0.1:9', ...args]);
    expect(argv.appServer).not.toContain('--profile');
    expect(argv.appServer).not.toContain('ci');
    expect(argv.appServer).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(argv.appServer).not.toContain('--sandbox');
  });
});

describe('concord adapters codex CLI (#269)', () => {
  it('accepts Codex flags without requiring a -- separator', async () => {
    const program = new Command();
    program.exitOverride();
    program.name('concord');
    registerAdaptersCommand(program);

    const adapters = program.commands.find((command) => command.name() === 'adapters');
    if (adapters === undefined) {
      throw new Error('expected adapters command');
    }
    const codex = adapters.commands.find((command) => command.name() === 'codex');
    if (codex === undefined) {
      throw new Error('expected adapters codex command');
    }

    let received: string[] | undefined;
    codex.action((...actionArgs: unknown[]) => {
      const [first] = actionArgs;
      if (
        Array.isArray(first) &&
        first.every((entry): entry is string => typeof entry === 'string')
      ) {
        received = first;
      }
    });

    await program.parseAsync(
      [
        'adapters',
        'codex',
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'model_provider=fake',
        '--profile',
        'ci',
      ],
      { from: 'user' },
    );

    expect(received).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'model_provider=fake',
      '--profile',
      'ci',
    ]);
  });
});
