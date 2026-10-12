import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { askQuestion, type PromptStreams } from '../../src/cli/commands/setup.js';

/** A terminal that types `keys` once the question is showing. */
function terminal(keys: string): PromptStreams & { printed: () => string } {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let printed = '';
  output.on('data', (chunk: Buffer) => {
    printed += chunk.toString();
  });
  setImmediate(() => input.write(keys));
  return { input, output, printed: () => printed };
}

describe('askQuestion', () => {
  it('returns what was typed', async () => {
    expect(await askQuestion('Go? ', terminal('n\r'))).toBe('n');
  });

  it('treats Ctrl+D as no answer instead of throwing, and ends the prompt line', async () => {
    const streams = terminal('\u0004');
    expect(await askQuestion('Go? ', streams)).toBeUndefined();
    expect(streams.printed().endsWith('\n')).toBe(true);
  });
});
