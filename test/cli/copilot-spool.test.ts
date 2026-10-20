import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fileSpool } from '../../src/cli/commands/copilot-spool.js';
import type { DeliverableMessage } from '../../src/domain/pull-inbox.js';

const message: DeliverableMessage = {
  messageId: 'm-1',
  senderAgentId: 'peer',
  taskId: null,
  content: 'held for the next hook',
  messageKind: 'prompt',
  deliveryLatencyMs: 12,
};

describe('fileSpool', () => {
  it('holds messages per agent until taken once', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-spool-'));
    const spool = fileSpool({ HOME: home });
    spool.put('copilot-cli:a', [message]);

    expect(spool.take('copilot-cli:b')).toEqual([]);
    expect(spool.take('copilot-cli:a')).toEqual([message]);
    expect(spool.take('copilot-cli:a')).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('writes owner-only files and nothing when empty', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-spool-'));
    const spool = fileSpool({ HOME: home });
    spool.put('copilot-cli:a', []);
    const dir = join(home, '.concord', 'copilot-spool');
    expect(existsSync(dir)).toBe(false);
    spool.put('copilot-cli:a', [message]);
    const [file] = readdirSync(dir);
    if (file === undefined) throw new Error('no spool file');
    expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
  });
});
