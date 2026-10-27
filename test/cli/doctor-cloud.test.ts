import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { runDoctorCommand } from '../../src/cli/commands/doctor.js';
import {
  archiveLeftovers,
  buildCloudDoctorReport,
  duplicateAgentKeys,
  findLeftovers,
} from '../../src/cli/commands/doctor-cloud.js';
import { REQUIRED_CAPABILITIES } from '../../src/cloud/client.js';
import { ensureMachineKey, writeCredentials } from '../../src/cloud/settings.js';
import { openDatabase } from '../../src/db/connection.js';
import { countTasksReadOnly } from '../../src/db/read-only.js';
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

  const report = (fetch = cloud().fetch, cleanLocal = false) =>
    buildCloudDoctorReport(repo, env, {
      fetch,
      originRemote: () => 'git@github.com:acme/app.git',
      cleanLocal: () => Promise.resolve(cleanLocal),
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

  it('lists leftover local state with its open work, and moves it aside only when asked', async () => {
    // A store from before the machine was linked, holding one open task.
    const store = join(repo, '.concord', 'concord.db');
    const repos = createRepositories(openDatabase(store));
    handleClaimWork(repos, { task_id: 'OLD-1', title: 'Old work', owner: 'me', agent: 'a' });
    repos.db.close();
    writeFileSync(join(repo, '.concord', 'cloud.json'), '{ "local": true }\n');

    const listed = await report();
    expect(listed.output).toContain(`${store}: this repository's local store, 1 open task(s)`);
    expect(listed.output).toContain('a repository link from before Concord 0.17');
    expect(listed.output).toContain('`concord doctor --clean-local` moves these aside');
    // Leftovers are information, not a failure.
    expect(listed.healthy).toBe(true);
    expect(existsSync(store)).toBe(true);

    const cleaned = await report(cloud().fetch, true);
    expect(cleaned.output).toContain('moved aside ->');
    expect(existsSync(store)).toBe(false);
    // Moved, never deleted.
    expect(
      readdirSync(join(repo, '.concord')).some((name) => name.startsWith('concord.db.archived-')),
    ).toBe(true);
    expect(findLeftovers(repo, env)).toEqual([]);
  });

  it('reports a store it cannot read rather than failing', () => {
    mkdirSync(join(repo, '.concord'), { recursive: true });
    writeFileSync(join(repo, '.concord', 'concord.db'), 'not a database');
    expect(findLeftovers(repo, env)[0]?.description).toContain('unreadable by this version');
  });

  it('moves a store aside with work still in its write-ahead log, readable where it lands', () => {
    // A store whose last commit is only in its WAL, as a local server started
    // before login can leave it: copied while a connection holds the commit
    // uncheckpointed.
    const live = mkdtempSync(join(tmpdir(), 'concord-live-'));
    const writer = new Database(join(live, 'concord.db'));
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec("CREATE TABLE tasks (status TEXT); INSERT INTO tasks VALUES ('active');");
    mkdirSync(join(repo, '.concord'), { recursive: true });
    for (const name of ['concord.db', 'concord.db-wal']) {
      copyFileSync(join(live, name), join(repo, '.concord', name));
    }
    writer.close();
    expect(statSync(join(repo, '.concord', 'concord.db-wal')).size).toBeGreaterThan(0);

    const { moved } = archiveLeftovers(
      findLeftovers(repo, env),
      new Date('2026-10-27T16:00:00.000Z'),
    );

    const archived = join(repo, '.concord', 'concord.db.archived-20261027T160000Z');
    expect(moved[0]).toBe(archived);
    expect(countTasksReadOnly(archived, ['active'])).toBe(1);
    expect(existsSync(join(repo, '.concord', 'concord.db'))).toBe(false);
    expect(existsSync(join(repo, '.concord', 'concord.db-wal'))).toBe(false);
  });

  it('leaves a store a running process has open exactly as it is', async () => {
    const store = join(repo, '.concord', 'concord.db');
    mkdirSync(join(repo, '.concord'), { recursive: true });
    const live = new Database(store);
    live.pragma('journal_mode = WAL');
    live.exec("CREATE TABLE tasks (status TEXT); INSERT INTO tasks VALUES ('active');");
    try {
      const result = await report(cloud().fetch, true);
      expect(result.output).toContain(
        `left in place: ${realpathSync(store)} is open in a running Concord process`,
      );
      expect(existsSync(store)).toBe(true);
      expect(readdirSync(join(repo, '.concord')).some((name) => name.includes('archived'))).toBe(
        false,
      );
    } finally {
      live.close();
    }
    // Once it is closed, the same request moves it.
    expect((await report(cloud().fetch, true)).output).toContain('moved aside ->');
    expect(existsSync(store)).toBe(false);
  });

  it('puts back what moved when one of the files cannot be moved', () => {
    mkdirSync(join(repo, '.concord'), { recursive: true });
    for (const name of ['concord.db', 'concord.db-wal']) {
      writeFileSync(join(repo, '.concord', name), 'not a database');
    }
    // Something already in the way of the log's archived name.
    const blocker = join(repo, '.concord', 'concord.db.archived-20261027T160000Z-wal');
    mkdirSync(join(blocker, 'occupied'), { recursive: true });

    expect(() =>
      archiveLeftovers(findLeftovers(repo, env), new Date('2026-10-27T16:00:00.000Z')),
    ).toThrow();
    expect(existsSync(join(repo, '.concord', 'concord.db'))).toBe(true);
    expect(existsSync(join(repo, '.concord', 'concord.db-wal'))).toBe(true);
    expect(existsSync(join(repo, '.concord', 'concord.db.archived-20261027T160000Z'))).toBe(false);
  });

  it('keeps an unreadable store paired with its companions by SQLite’s naming', () => {
    mkdirSync(join(repo, '.concord'), { recursive: true });
    for (const name of ['concord.db', 'concord.db-wal', 'concord.db-shm']) {
      writeFileSync(join(repo, '.concord', name), 'not a database');
    }
    const { moved } = archiveLeftovers(
      findLeftovers(repo, env),
      new Date('2026-10-27T16:00:00.000Z'),
    );
    expect(moved.map((path) => path.slice(repo.length))).toEqual([
      '/.concord/concord.db.archived-20261027T160000Z',
      '/.concord/concord.db.archived-20261027T160000Z-wal',
      '/.concord/concord.db.archived-20261027T160000Z-shm',
    ]);
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
