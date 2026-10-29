import { afterEach, describe, expect, it, vi } from 'vitest';

import { launchCopilot } from '../../src/cli/commands/copilot-adapter.js';
import { launchGemini } from '../../src/cli/commands/gemini-adapter.js';
import { reportMissingHarnessCli } from '../../src/cli/commands/missing-harness-cli.js';

/** Collects what a launcher writes without touching the real stderr. */
function errorStream(): { lines: string[]; write(chunk: string): boolean } {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string): boolean {
      lines.push(chunk);
      return true;
    },
  };
}

describe('missing harness CLI (#299)', () => {
  const realPath = process.env['PATH'];
  const realExitCode = process.exitCode;

  afterEach(() => {
    if (realPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = realPath;
    process.exitCode = realExitCode;
    vi.restoreAllMocks();
  });

  it('prints one install line instead of a stack trace', () => {
    const stderr = errorStream();
    reportMissingHarnessCli('Gemini CLI', 'npm i -g @google/gemini-cli', stderr);

    expect(stderr.lines).toEqual([
      'Concord: Gemini CLI was not found on PATH. ' +
        'Install it (npm i -g @google/gemini-cli) and try again.\n',
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('reports Gemini as an error, not an exception, when the CLI is missing', async () => {
    process.env['PATH'] = '';
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(launchGemini([])).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalledWith(
      'Concord: Gemini CLI was not found on PATH. ' +
        'Install it (npm i -g @google/gemini-cli) and try again.\n',
    );
    expect(process.exitCode).toBe(1);
  });

  it('reports Copilot as an error, not an exception, when the CLI is missing', async () => {
    process.env['PATH'] = '';
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(launchCopilot([])).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalledWith(
      'Concord: Copilot CLI was not found on PATH. ' +
        'Install it (npm i -g @github/copilot) and try again.\n',
    );
    expect(process.exitCode).toBe(1);
  });
});
