import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import {
  errorMessage,
  taskIdFromArgs,
  withRecordedEvents,
} from '../../src/tools/recorded-events.js';

/**
 * A repository whose event write always fails, as a locked database would.
 *
 * Built over a real in-memory database with only the recorder replaced, so the
 * double needs no cast and satisfies the full repository type.
 */
function brokenRepos(): Pick<Repositories, 'events'> {
  const repos = createRepositories(openDatabase(':memory:'));
  const events = repos.events;
  return {
    events: {
      record: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
      list: () => events.list(),
      listByTask: (taskId: string) => events.listByTask(taskId),
    },
  };
}

describe('withRecordedEvents', () => {
  it('re-throws the handler error even when recording the event throws', () => {
    const wrapped = withRecordedEvents(brokenRepos())('start_work', () => {
      throw new Error('the real failure');
    });

    // A lost event is recoverable; a masked error is not. The caller must see
    // the tool's own failure, never the recorder's.
    expect(() => wrapped({ task_id: 'T1' })).toThrow('the real failure');
  });

  it('re-throws a rejected promise even when recording the event throws', async () => {
    const wrapped = withRecordedEvents(brokenRepos())('update_work', () =>
      // An async tool that fails after doing partial work is exactly the case
      // an audit trail needs to see, so the rejection path must be covered too.
      Promise.reject(new Error('the real async failure')),
    );

    await expect(wrapped({ task_id: 'T2' })).rejects.toThrow('the real async failure');
  });

  it('notifies clients of the state change a failure event represents', () => {
    // A recorded failure is a change to work state; without the notification a
    // dashboard shows nothing until some unrelated write happens to notify.
    let notified = 0;
    const repos = createRepositories(openDatabase(':memory:'));
    const wrapped = withRecordedEvents(repos, () => {
      notified += 1;
    })('start_work', () => {
      throw new Error('the real failure');
    });

    expect(() => wrapped({ task_id: 'T1' })).toThrow('the real failure');
    expect(notified).toBe(1);
  });

  it('still notifies when the event itself could not be recorded', () => {
    // The notification is what makes a failure visible, so it must not depend
    // on the write succeeding.
    let notified = 0;
    const wrapped = withRecordedEvents(brokenRepos(), () => {
      notified += 1;
    })('start_work', () => {
      throw new Error('the real failure');
    });

    expect(() => wrapped({ task_id: 'T1' })).toThrow('the real failure');
    expect(notified).toBe(1);
  });
  it('re-throws the handler error even when the notification throws', () => {
    // A full disk while writing the exported artifact must not replace the
    // caller's real error with an ENOSPC from the audit trail.
    const repos = createRepositories(openDatabase(':memory:'));
    const wrapped = withRecordedEvents(repos, () => {
      throw new Error('ENOSPC: no space left on device');
    })('start_work', () => {
      throw new Error('the real failure');
    });

    expect(() => wrapped({ task_id: 'T1' })).toThrow('the real failure');
  });

  it('still writes the event when the notification throws', () => {
    // The notification and the event are independent: a failed notification
    // must not cost the audit trail its record of the failure.
    const repos = createRepositories(openDatabase(':memory:'));
    const wrapped = withRecordedEvents(repos, () => {
      throw new Error('ENOSPC: no space left on device');
    })('start_work', () => {
      throw new Error('the real failure');
    });

    expect(() => wrapped({ task_id: 'T1' })).toThrow('the real failure');
    const failures = repos.events.list().filter((event) => event.status === 'error');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.tool).toBe('start_work');
  });
});

describe('taskIdFromArgs', () => {
  it('reads a task id the call names', () => {
    expect(taskIdFromArgs({ task_id: 'T1' })).toBe('T1');
  });

  it('returns null when there is no task id to attach the event to', () => {
    expect(taskIdFromArgs({})).toBeNull();
    expect(taskIdFromArgs(null)).toBeNull();
    expect(taskIdFromArgs('not an object')).toBeNull();
    expect(taskIdFromArgs({ task_id: '' })).toBeNull();
    expect(taskIdFromArgs({ task_id: 42 })).toBeNull();
  });
});

describe('errorMessage', () => {
  it('takes the message and nothing else from an Error', () => {
    const error = new Error('a path: /etc/passwd token abc123');
    expect(errorMessage(error)).toBe('a path: /etc/passwd token abc123');
  });

  it('never reads a stack, which can carry local file paths', () => {
    const error = new Error('boom');
    expect(errorMessage(error)).not.toContain('at ');
  });

  it('caps a pathological message so one cannot bloat the log', () => {
    expect(errorMessage(new Error('x'.repeat(5000)))).toHaveLength(500);
  });

  it('handles a thrown value that is not an Error', () => {
    expect(errorMessage('plain string')).toBe('plain string');
  });
});
