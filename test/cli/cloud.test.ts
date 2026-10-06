import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runCloudLogin, runCloudLogout, type CloudDeps } from '../../src/cli/commands/cloud.js';
import { REQUIRED_CAPABILITIES, type Fetch } from '../../src/cloud/client.js';
import { credentialsPath, ensureMachineKey, readMachineKey } from '../../src/cloud/settings.js';

const API = 'https://api.concord.test';
const KEY = 'cak_live_0123456789abcdef';

const META = {
  apiVersion: 1,
  capabilities: [...REQUIRED_CAPABILITIES],
  mcp: { endpoint: '/mcp', tools: [] },
};

/** A fake Concord Cloud: serves meta, and accepts only `KEY`. */
function fakeCloud(meta: object = META): { fetch: Fetch; machines: string[] } {
  const machines: string[] = [];
  const fetch: Fetch = (input, init) => {
    if (init?.method === 'POST' && typeof init.body === 'string') machines.push(init.body);
    if (input.endsWith('/v1/meta')) return Promise.resolve(Response.json(meta));
    const auth = new Headers(init?.headers).get('authorization');
    return Promise.resolve(
      auth === `Bearer ${KEY}`
        ? Response.json({ machines: [] })
        : new Response('unauthorized', { status: 401 }),
    );
  };
  return { fetch, machines };
}

describe('concord cloud', () => {
  let home: string;
  let deps: CloudDeps;
  let minted = 0;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'concord-home-'));
    deps = {
      env: { HOME: home, CONCORD_CLOUD_API_KEY: KEY },
      cwd: home,
      fetch: fakeCloud().fetch,
      readStdin: () => Promise.resolve(`${KEY}\n`),
      hostname: () => 'devbox',
      newMachineKey: () => `machine-${String(++minted)}`,
    };
  });

  it('logs in from the environment and stores the key privately', async () => {
    const out = await runCloudLogin({ url: API }, deps);
    expect(out).toContain('Logged in');
    expect(out).not.toContain(KEY);
    const path = credentialsPath(deps.env);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ apiUrl: API, apiKey: KEY });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reads the key from stdin when asked, trimmed', async () => {
    await runCloudLogin({ url: API, keyStdin: true }, { ...deps, env: { HOME: home } });
    expect(readFileSync(credentialsPath(deps.env), 'utf8')).toContain(`"${KEY}"`);
  });

  it('refuses without a key, with a rejected key, or against an incompatible API', async () => {
    await expect(runCloudLogin({ url: API }, { ...deps, env: { HOME: home } })).rejects.toThrow(
      /--key-stdin/,
    );
    await expect(
      runCloudLogin({ url: API }, { ...deps, env: { HOME: home, CONCORD_CLOUD_API_KEY: 'x' } }),
    ).rejects.toThrow(/rejected/);
    const old = { ...META, capabilities: ['projects'] };
    await expect(
      runCloudLogin({ url: API }, { ...deps, fetch: fakeCloud(old).fetch }),
    ).rejects.toThrow(/lacks .*claims-check/);
    expect(existsSync(credentialsPath(deps.env))).toBe(false);
  });

  it('registers this machine at login, and keeps its key across logins', async () => {
    const cloud = fakeCloud();
    await runCloudLogin({ url: API }, { ...deps, fetch: cloud.fetch });
    await runCloudLogin({ url: API }, { ...deps, fetch: cloud.fetch });

    const sent = cloud.machines.map((body) =>
      z.object({ machineKey: z.string(), name: z.string() }).parse(JSON.parse(body)),
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(sent[0]?.name).toBe('devbox');
  });

  it('agrees on one machine key when two first logins race', () => {
    const key = ensureMachineKey(deps.env, () => {
      // Another login saves its key while this one is still minting.
      expect(ensureMachineKey(deps.env, () => 'winner')).toBe('winner');
      return 'loser';
    });
    expect(key).toBe('winner');
    expect(readMachineKey(deps.env)).toBe('winner');
  });

  it('logs out, forgetting the key but not the machine', async () => {
    expect(runCloudLogout(deps)).toBe('Not logged in.');
    await runCloudLogin({ url: API }, deps);
    const machine = readMachineKey(deps.env);
    expect(runCloudLogout(deps)).toContain('Logged out');
    expect(existsSync(credentialsPath(deps.env))).toBe(false);

    await runCloudLogin({ url: API }, deps);
    expect(readMachineKey(deps.env)).toBe(machine);
  });

  it('sends a key only over https, or http to this machine', async () => {
    await expect(runCloudLogin({ url: 'http://api.concord.test' }, deps)).rejects.toThrow(
      /not https/,
    );
    expect(await runCloudLogin({ url: 'http://127.0.0.1:8080' }, deps)).toContain('Logged in');
  });

  it('replaces a readable credentials file with a private one', async () => {
    if (process.platform === 'win32') return;
    const path = credentialsPath(deps.env);
    mkdirSync(join(home, '.concord'), { recursive: true });
    writeFileSync(path, '{}');
    chmodSync(path, 0o644);
    await runCloudLogin({ url: API }, deps);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reports a server error page as one short line', async () => {
    const page = `<html>\n<body>\n${'Bad gateway. '.repeat(100)}\n</body></html>`;
    const failing: Fetch = (input) =>
      Promise.resolve(
        input.endsWith('/v1/meta') ? Response.json(META) : new Response(page, { status: 502 }),
      );
    // One line, and short: the page is flattened and cut, not printed whole.
    await expect(runCloudLogin({ url: API }, { ...deps, fetch: failing })).rejects.toThrow(
      /^[^\n]{1,400}$/,
    );
  });
});
