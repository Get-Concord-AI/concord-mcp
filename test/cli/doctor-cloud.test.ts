import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { runDoctorCommand } from '../../src/cli/commands/doctor.js';
import {
  buildCloudDoctorReport,
  duplicateAgentKeys,
  findLeftovers,
  moveAsideCommands,
} from '../../src/cli/commands/doctor-cloud.js';
import { REQUIRED_CAPABILITIES } from '../../src/cloud/client.js';
import { ensureMachineKey, writeCredentials } from '../../src/cloud/settings.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';
import { fakeCloud, ok } from '../cloud/fake-cloud.js';

const API = 'https://api.concord.test';
const META = {
  apiVersion: 1,
  capabilities: [...REQUIRED_CAPABILITIES],
  mcp: { endpoint: '/mcp', tools: [] },
};

const agent = (agentKey: string) => ({
  id: `${agentKey}-uuid`,
  agentKey,
  kind: 'claude-code',
  summary: null,
  status: 'active',
  lastSeenAt: '2026-10-27T00:00:00.000Z',
});

describe('doctor on a linked machine', () => {
  let home: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'concord-home-'));
    repo = mkdtempSync(join(tmpdir(), 'concord-repo-'));
    mkdirSync(join(repo, '.git'));
    env = { HOME: home, CONCORD_REPO_ROOT: repo };
    writeCredentials(env, { apiUrl: API, apiKey: 'ck_test' });
    ensureMachineKey(env, () => 'machine-1');
  });

  const cloud = (agents = [agent('claude-code:aaaa1111')]) =>
    fakeCloud([
      ['GET /v1/meta', () => ok(META)],
      ['GET /v1/machines', () => ok({ machines: [] })],
      ['GET /v1/agents', () => ok({ agents })],
    ]);

  const report = (fetch = cloud().fetch) =>
    buildCloudDoctorReport(repo, env, {
      fetch,
      originRemote: () => 'git@github.com:acme/app.git',
    });

  it('checks the cloud and never creates a local store', async () => {
    const result = await report();

    expect(result.output).toContain('Machine: linked');
    expect(result.output).toContain('is github.com/acme/app on Concord Cloud');
    expect(result.output).toContain('Key: accepted');
    expect(result.output).toContain('Agent ids: unique');
    expect(result.output).toMatch(/Local state \(unused while this machine is linked\)\n {2}none/u);
    expect(result.healthy).toBe(true);
    expect(existsSync(join(repo, '.concord'))).toBe(false);
    expect(existsSync(join(home, '.concord', 'global.db'))).toBe(false);
  });

  it('reports agent ids that name several agents, which cannot be messaged', async () => {
    const twins = [agent('claude-code:6e68ecad'), agent('claude-code:6e68ecad'), agent('x:1')];
    expect([...duplicateAgentKeys(twins)]).toEqual([['claude-code:6e68ecad', 2]]);

    const result = await report(cloud(twins).fetch);
    expect(result.output).toContain('cannot be delivered: claude-code:6e68ecad (2)');
    expect(result.healthy).toBe(false);
  });

  it('lists leftover local state with its open work, and the commands to move it aside', async () => {
    // A store from before the machine was linked, holding one open task.
    const store = join(repo, '.concord', 'concord.db');
    const repos = createRepositories(openDatabase(store));
    handleClaimWork(repos, { task_id: 'OLD-1', title: 'Old work', owner: 'me', agent: 'a' });
    repos.db.close();
    writeFileSync(`${store}-wal`, '');
    writeFileSync(join(repo, '.concord', 'cloud.json'), '{ "local": true }\n');

    const listed = await report();
    const resolved = realpathSync(store);
    expect(listed.output).toContain(`${resolved}: this repository's local store, 1 open task(s)`);
    expect(listed.output).toContain('a repository link from before Concord 0.17');
    // SQLite's pairing is kept, so a log holding committed work stays with its database.
    expect(listed.output).toContain(`mv '${resolved}' '${resolved}.archived'`);
    expect(listed.output).toContain(`mv '${resolved}-wal' '${resolved}.archived-wal'`);
    // Leftovers are information, not a failure, and doctor moves nothing itself.
    expect(listed.healthy).toBe(true);
    expect(existsSync(store)).toBe(true);
    expect(readdirSync(join(repo, '.concord')).some((name) => name.includes('archived'))).toBe(
      false,
    );
  });

  it('quotes paths in the commands it suggests', () => {
    expect(
      moveAsideCommands([
        { path: "/tmp/it's/concord.db", description: '', files: ["/tmp/it's/concord.db"] },
      ]),
    ).toEqual([`mv '/tmp/it'\\''s/concord.db' '/tmp/it'\\''s/concord.db.archived'`]);
  });

  it('reports a store it cannot read rather than failing', () => {
    mkdirSync(join(repo, '.concord'), { recursive: true });
    writeFileSync(join(repo, '.concord', 'concord.db'), 'not a database');
    expect(findLeftovers(repo, env)[0]?.description).toContain('unreadable by this version');
  });

  it('is what `concord doctor` runs on a linked machine', async () => {
    const result = await runDoctorCommand(repo, env, { isEphemeral: () => false });
    expect(result.output).toContain('Concord Cloud');
    expect(existsSync(join(repo, '.concord'))).toBe(false);
  });
});

describe('doctor on an unlinked machine', () => {
  it('reports a store it cannot migrate instead of crashing', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'concord-repo-'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, '.concord'));
    writeFileSync(join(repo, '.concord', 'concord.db'), 'not a database');
    const env = { HOME: mkdtempSync(join(tmpdir(), 'concord-home-')), CONCORD_REPO_ROOT: repo };

    const result = await runDoctorCommand(repo, env, { isEphemeral: () => false });

    expect(result.output).toContain('store        unreadable:');
    expect(result.healthy).toBe(false);
  });
});
