import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { statusQwen } from '../../src/install/adapters/qwen.js';

describe('statusQwen', () => {
  it('reports not_detected without reading settings when Qwen is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-qwen-status-'));
    // A folder where the settings file should be would throw if it were read.
    mkdirSync(join(root, '.qwen', 'settings.json'), { recursive: true });
    expect(statusQwen(undefined, root).status).toBe('not_detected');
  });

  it('reports unreadable settings instead of throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'concord-qwen-status-'));
    mkdirSync(join(root, '.qwen', 'settings.json'), { recursive: true });
    const report = statusQwen('/usr/bin/qwen', root);
    expect(report.status).toBe('action_required');
    expect(report.detail).toContain('could not be read');
  });
});
