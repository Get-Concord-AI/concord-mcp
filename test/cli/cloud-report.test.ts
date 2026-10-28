import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CloudDeps } from '../../src/cli/commands/cloud.js';
import {
  cloudAgentsReport,
  cloudStatusReport,
  runCloudAgents,
} from '../../src/cli/commands/cloud-report.js';
import { REQUIRED_CAPABILITIES, type Fetch } from '../../src/cloud/client.js';
import { ensureMachineKey, writeCredentials } from '../../src/cloud/settings.js';
import { writeUserConfig } from '../../src/config/user-config.js';

const API = 'https://api.concord.test';
const KEY = 'cak_live_0123456789abcdef';
const META = {
  apiVersion: 1,
  capabilities: [...REQUIRED_CAPABILITIES],
  mcp: { endpoint: '/mcp', tools: [] },
};
const SEEN = { id: 'a1', kind: 'claude-code', lastSeenAt: '2026-10-26T10:00:00.000Z' };

/** A fake Concord Cloud that accepts `KEY` and knows the machines it is given. */
function fakeCloud(machines: Record<string, string>): Fetch {
  return (input, init) => {
    if (input.endsWith('/v1/meta')) return Promise.resolve(Response.json(META));
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${KEY}`) {
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    }
    if (input.endsWith('/v1/machines')) {
      const listed = Object.entries(machines).map(([machineKey, id]) => ({ id, machineKey }));
      return Promise.resolve(Response.json({ machines: listed }));
    }
    if (input.endsWith('/v1/agents?machineId=m-1')) {
      return Promise.resolve(Response.json({ agents: [{ ...SEEN, extra: 'ignored' }] }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

const statusSchema = z.object({
  schema: z.literal(1),
  login: z.object({ apiUrl: z.string(), method: z.enum(['api-key', 'browser']) }).nullable(),
  apiCompatible: z.boolean().nullable(),
  keyAccepted: z.boolean().nullable(),
  machineKey: z.string().nullable(),
  linked: z.boolean(),
  folder: z.object({
    root: z.string(),
    isRepository: z.boolean(),
    project: z.string().nullable(),
  }),
});

async function status(deps: CloudDeps): Promise<z.infer<typeof statusSchema>> {
  // Through JSON and back, as a script reads it.
  const raw: unknown = JSON.parse(JSON.stringify(await cloudStatusReport(deps)));
  return statusSchema.parse(raw);
}

describe('concord cloud status --json and concord cloud agents', () => {
  let repo: string;
  let deps: CloudDeps;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'concord-home-'));
    repo = mkdtempSync(join(tmpdir(), 'concord-repo-'));
    mkdirSync(join(repo, '.git'));
    deps = {
      env: { HOME: home },
      cwd: repo,
      fetch: fakeCloud({ 'machine-1': 'm-1' }),
      readStdin: () => Promise.resolve(''),
      originRemote: () => 'git@github.com:Acme/App.git',
      hostname: () => 'devbox',
      newMachineKey: () => 'machine-1',
      browser: {
        openUrl: () => undefined,
        print: () => undefined,
        readLine: () => Promise.resolve(''),
      },
    };
  });

  function signIn(apiKey = KEY): void {
    writeCredentials(deps.env, { apiUrl: API, apiKey });
    ensureMachineKey(deps.env, deps.newMachineKey);
  }

  it('reports a signed-out machine as unlinked, with nothing checked', async () => {
    expect(await status(deps)).toEqual({
      schema: 1,
      login: null,
      apiCompatible: null,
      keyAccepted: null,
      machineKey: null,
      linked: false,
      folder: { root: repo, isRepository: true, project: null },
    });
  });

  it("reports a working login, a linked machine and this folder's project", async () => {
    signIn();
    const report = await status(deps);
    expect(report.login).toEqual({ apiUrl: API, method: 'api-key' });
    expect(report.apiCompatible).toBe(true);
    expect(report.keyAccepted).toBe(true);
    expect(report.machineKey).toBe('machine-1');
    expect(report.linked).toBe(true);
    expect(report.folder.project).toBe('github.com/acme/app');

    writeUserConfig(deps.env, { cloudLink: false });
    const unlinked = await status(deps);
    expect(unlinked.linked).toBe(false);
    expect(unlinked.folder.project).toBeNull();
  });

  it('says a rejected key is rejected, and an unreachable API unknown', async () => {
    signIn('cak_live_revoked');
    expect((await status(deps)).keyAccepted).toBe(false);

    const down: Fetch = () => Promise.reject(new Error('offline'));
    const offline = await status({ ...deps, fetch: down });
    expect(offline.apiCompatible).toBeNull();
    expect(offline.keyAccepted).toBeNull();
  });

  it('lists the agents seen on this machine, and only their public fields', async () => {
    signIn();
    expect(await cloudAgentsReport(deps)).toEqual({
      schema: 1,
      machineRegistered: true,
      agents: [SEEN],
    });
    expect(await runCloudAgents(deps)).toContain('claude-code');
  });

  it('says when the cloud does not know this machine, and refuses when signed out', async () => {
    await expect(cloudAgentsReport(deps)).rejects.toThrow('Not logged in');
    signIn();
    const unknown = { ...deps, fetch: fakeCloud({}) };
    expect(await cloudAgentsReport(unknown)).toEqual({
      schema: 1,
      machineRegistered: false,
      agents: [],
    });
    expect(await runCloudAgents(unknown)).toContain('does not know this machine');
  });
});
