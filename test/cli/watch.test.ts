import { beforeEach, describe, expect, it } from 'vitest';

import { watchSnapshot } from '../../src/cli/commands/watch.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { handleClaimWork } from '../../src/tools/claim-work.js';

describe('watchSnapshot', () => {
  let repos: Repositories;
  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
  });

  it('renders the current work-state (what concord watch prints on each change)', () => {
    const empty = watchSnapshot(repos);
    expect(empty).toContain('Active work');
    expect(empty).toContain('none');

    handleClaimWork(repos, { task_id: 'T1', title: 'Frontend', agent: 'codex' });
    const withWork = watchSnapshot(repos);
    expect(withWork).toContain('T1');
    expect(withWork).toContain('codex');
  });
});
