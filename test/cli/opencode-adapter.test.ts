import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  OpenCodeSessionAdapter,
  identityNotice,
  launchDirectory,
  newOpencodeSessionId,
  opencodeLaunchPlan,
  prepareSession,
  serverFrom,
  startOpencodeHost,
} from '../../src/cli/commands/opencode-adapter.js';
import { SWEEP_AFTER_MS, sweepStragglers } from '../../src/cli/commands/session-sweep.js';
import { registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { openContext } from '../../src/cli/context.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import { handleSendAgentMessage } from '../../src/tools/agent-messages.js';
import { handleRegisterAgent } from '../../src/tools/register-agent.js';

describe('newOpencodeSessionId', () => {
  it('makes distinct ids OpenCode accepts (ses…)', () => {
    const ids = [newOpencodeSessionId(), newOpencodeSessionId()];

    expect(ids[0]).toMatch(/^ses_concord[0-9a-f]{18}$/u);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('identityNotice', () => {
  it('names the agent id to pass on every call', () => {
    const notice = identityNotice('opencode:ab12cd34');

    expect(notice).toContain('your agent_id is opencode:ab12cd34');
    expect(notice).toContain('Pass agent_id "opencode:ab12cd34" on every Concord tool call.');
  });
});

describe('opencodeLaunchPlan', () => {
  it('opens the chosen session and forwards the rest', () => {
    expect(opencodeLaunchPlan('ses_x', ['--model', 'a/b'])).toEqual([
      '--session',
      'ses_x',
      '--model',
      'a/b',
    ]);
  });

  it('declines to host when the user picked their own session', () => {
    for (const args of [['-s', 'ses_y'], ['--session=ses_y'], ['--continue'], ['-c']]) {
      expect(opencodeLaunchPlan('ses_x', args)).toBeUndefined();
    }
  });
});

describe('launchDirectory', () => {
  it('is where the launcher ran unless a directory is given', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'concord-oc-cwd-'));
    mkdirSync(join(cwd, 'proj'));

    expect(launchDirectory([], cwd)).toBe(cwd);
    expect(launchDirectory(['proj'], cwd)).toBe(join(cwd, 'proj'));
  });

  it('does not take a flag value for a directory', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'concord-oc-cwd-'));
    mkdirSync(join(cwd, 'proj'));

    expect(launchDirectory(['--prompt', 'proj'], cwd)).toBe(cwd);
    expect(launchDirectory(['--auto', 'missing'], cwd)).toBe(cwd);
  });
});

describe('prepareSession', () => {
  it('creates the session in the directory, then admits the identity without a turn', async () => {
    const calls: { method: string; path: string; body: string | undefined }[] = [];

    await prepareSession(
      (method, path, body) => {
        calls.push({ method, path, body });
        return Promise.resolve('{}');
      },
      'ses_x',
      'opencode:ab12cd34',
      '/work/repo',
    );

    const sent = calls.map((call) => ({
      ...call,
      body: call.body === undefined ? undefined : z.json().parse(JSON.parse(call.body)),
    }));
    expect(sent).toEqual([
      {
        method: 'POST',
        path: '/api/session',
        body: { id: 'ses_x', title: 'Concord session', location: { directory: '/work/repo' } },
      },
      {
        method: 'POST',
        path: '/api/session/ses_x/synthetic',
        body: {
          text: identityNotice('opencode:ab12cd34'),
          description: 'Concord agent identity',
          resume: false,
        },
      },
    ]);
  });

  it('stops before the identity when the session cannot be created', async () => {
    const paths: string[] = [];

    await expect(
      prepareSession(
        (_method, path) => {
          paths.push(path);
          return Promise.reject(new Error('HTTP 500'));
        },
        'ses_x',
        'opencode:ab12cd34',
        '/work/repo',
      ),
    ).rejects.toThrow('HTTP 500');
    expect(paths).toEqual(['/api/session']);
  });
});

describe('OpenCodeSessionAdapter with the shared sweep', () => {
  const AGENT = 'opencode:host';

  it('hands a missed message to OpenCode and records the opencode provider', async () => {
    const repos = createRepositories(openDatabase(':memory:'));
    handleRegisterAgent(repos, { agent_id: AGENT, kind: 'opencode' });
    handleRegisterAgent(repos, { agent_id: 'peer', kind: 'claude-code' });
    registerPullEndpoint(repos, AGENT, 'opencode');
    const id = handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'peer',
      toAgentId: AGENT,
      content: 'Please review.',
      idempotencyKey: 'k-1',
    }).message.messageId;
    const pushed: { content: string; mode: string }[] = [];
    const client = {
      isBusy: () => true,
      pushPrompt: (content: string, mode: 'steer' | 'inject') => {
        pushed.push({ content, mode });
        return Promise.resolve('receipt-1');
      },
    };
    const adapter = new OpenCodeSessionAdapter(client);

    await sweepStragglers(repos, AGENT, adapter, Date.now() + SWEEP_AFTER_MS + 1_000);

    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.mode).toBe('steer');
    expect(pushed[0]?.content).toMatch(/Please review\.$/u);
    expect(repos.agentMessages.get(id)?.status).toBe('delivered');
  });
});

describe('serverFrom', () => {
  it('reads the server OpenCode will connect to, in either flag form', () => {
    expect(serverFrom(['--server', 'http://localhost:4096'])).toBe('http://localhost:4096');
    expect(serverFrom(['--auto', '--server=http://h:1'])).toBe('http://h:1');
    expect(serverFrom(['--auto'])).toBeUndefined();
  });
});

describe('startOpencodeHost', () => {
  it('hosts in the workspace of the directory it is given, not the launcher’s', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'concord-oc-host-')));
    execFileSync('git', ['init', '-q'], { cwd: other });
    const host = await startOpencodeHost(
      'opencode:other01',
      'ses_x',
      () => Promise.resolve('{"data":{}}'),
      other,
    );
    try {
      expect(openContext(other).repos.agents.get('opencode:other01')?.agentId).toBe(
        'opencode:other01',
      );
    } finally {
      await host.stop();
    }
  });
});
