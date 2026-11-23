import { Command } from '@commander-js/extra-typings';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ensureMachineKey, writeCredentials } from '../../src/cloud/settings.js';
import { LINKED_MACHINE_MESSAGE } from '../../src/cloud/target.js';
import { registerCloudCompatibleCommands } from '../../src/cli/commands/cloud-compatible.js';

describe('linked-machine CLI commands', () => {
  it('keeps setup, messages, doctor repair, and check task options registered', () => {
    const program = new Command();
    registerCloudCompatibleCommands(program);

    const names = program.commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(['check', 'doctor', 'messages', 'setup']));

    const check = program.commands.find((command) => command.name() === 'check');
    expect(check?.options.some((option) => option.long === '--task')).toBe(true);

    const doctor = program.commands.find((command) => command.name() === 'doctor');
    expect(doctor?.options.some((option) => option.long === '--fix')).toBe(true);
  });

  it('accepts --task for check on a linked machine without opening local state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-linked-cli-'));
    vi.stubEnv('HOME', home);
    writeCredentials(process.env, {
      apiUrl: 'https://api.concord.test',
      apiKey: 'test-only',
    });
    ensureMachineKey(process.env, () => 'machine-test');

    const program = new Command();
    program.exitOverride();
    registerCloudCompatibleCommands(program);

    await expect(
      program.parseAsync(['node', 'concord', 'check', '--task', 'TASK-1', 'src/index.ts']),
    ).resolves.toBe(program);
  });

  it('answers concord work with the linked-machine error instead of an unknown command', async () => {
    const program = new Command();
    program.exitOverride();
    registerCloudCompatibleCommands(program);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await program.parseAsync(['node', 'concord', 'work', 'start', '--json', 'args.json']);
      expect(stdout).toHaveBeenCalledWith(`${JSON.stringify({ error: LINKED_MACHINE_MESSAGE })}\n`);
      expect(process.exitCode).toBe(1);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      process.exitCode = undefined;
    }
  });
});
