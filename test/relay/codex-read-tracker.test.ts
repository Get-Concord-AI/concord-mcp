import { describe, expect, it } from 'vitest';

import { CodexReadTracker } from '../../src/relay/codex-read-tracker.js';

function tracker(): { reads: string[][]; tracker: CodexReadTracker } {
  const reads: string[][] = [];
  return {
    reads,
    tracker: new CodexReadTracker('thread-1', (ids) => {
      reads.push(ids);
    }),
  };
}

const item = (turnId: string, clientId: string | null, text = 'hello') => ({
  threadId: 'thread-1',
  turnId,
  item: { type: 'userMessage', clientId, content: [{ type: 'text', text }] },
});
const modelItem = (turnId: string, type = 'agentMessage') => ({
  threadId: 'thread-1',
  turnId,
  item: { type, id: `${turnId}-${type}` },
});
const completed = (id: string, status = 'completed', threadId = 'thread-1') => ({
  threadId,
  turn: { id, status },
});

describe('CodexReadTracker', () => {
  it('reads a pushed message once its input item is recorded and the turn completes', () => {
    const { reads, tracker: t } = tracker();
    t.expect('m1');
    t.notify('item/completed', item('turn-1', 'm1'));
    expect(reads).toEqual([]);
    t.notify('turn/completed', completed('turn-1'));
    expect(reads).toEqual([['m1']]);
  });

  it('reads a pushed message as soon as the model starts its own item after it', () => {
    const reads: [string[], string][] = [];
    const t = new CodexReadTracker('thread-1', (ids, evidence) => {
      reads.push([ids, evidence]);
    });
    t.expect('m1');
    t.notify('item/started', item('turn-1', 'm1'));
    t.notify('item/started', modelItem('turn-1', 'reasoning'));
    expect(reads).toEqual([[['m1'], 'model_output']]);
    // The turn completing later reports nothing new.
    t.notify('turn/completed', completed('turn-1'));
    expect(reads).toHaveLength(1);
  });

  it('does not count model output that started before a steered message landed', () => {
    const { reads, tracker: t } = tracker();
    t.expect('m1');
    t.notify('item/started', modelItem('turn-1', 'commandExecution'));
    t.notify('item/completed', item('turn-1', 'm1'));
    // The command finishing was sampled without the message.
    t.notify('item/completed', modelItem('turn-1', 'commandExecution'));
    expect(reads).toEqual([]);
    t.notify('item/started', modelItem('turn-1', 'agentMessage'));
    expect(reads).toEqual([['m1']]);
  });

  it('reads a message the model answered even if the turn is then interrupted', () => {
    const { reads, tracker: t } = tracker();
    t.expect('m1');
    t.notify('item/completed', item('turn-1', 'm1'));
    t.notify('item/started', modelItem('turn-1'));
    t.notify('turn/completed', completed('turn-1', 'interrupted'));
    expect(reads).toEqual([['m1']]);
  });

  it('matches the rendered header when Codex reports no client id', () => {
    const { reads, tracker: t } = tracker();
    t.expect('m1');
    t.notify('item/completed', item('turn-1', null, '[concord from a id=m1]\nhi'));
    t.notify('turn/completed', completed('turn-1'));
    expect(reads).toEqual([['m1']]);
  });

  it('handles the turn completing before its item is reported', () => {
    const { reads, tracker: t } = tracker();
    t.expect('m1');
    t.notify('turn/completed', completed('turn-1'));
    t.notify('item/completed', item('turn-1', 'm1'));
    expect(reads).toEqual([['m1']]);
  });

  it('leaves an interrupted or failed turn with no model output unread', () => {
    const { reads, tracker: t } = tracker();
    t.expect('m1');
    t.expect('m2');
    t.notify('item/completed', item('turn-1', 'm1'));
    t.notify('turn/completed', completed('turn-1', 'interrupted'));
    t.notify('item/completed', item('turn-2', 'm2'));
    t.notify('turn/completed', completed('turn-2', 'failed'));
    expect(reads).toEqual([]);
  });

  it('ignores other threads, unknown messages, and turns without our input', () => {
    const { reads, tracker: t } = tracker();
    t.expect('m1');
    t.notify('item/completed', { ...item('turn-1', 'm1'), threadId: 'thread-2' });
    t.notify('item/completed', item('turn-1', 'someone-else'));
    t.notify('turn/completed', completed('turn-1'));
    t.notify('turn/completed', completed('turn-9'));
    expect(reads).toEqual([]);
  });

  it('reports each message once, even across several steers in one turn', () => {
    const { reads, tracker: t } = tracker();
    t.expect('m1');
    t.expect('m2');
    t.notify('item/started', item('turn-1', 'm1'));
    t.notify('item/completed', item('turn-1', 'm1'));
    t.notify('item/completed', item('turn-1', 'm2'));
    t.notify('turn/completed', completed('turn-1'));
    t.notify('turn/completed', completed('turn-1'));
    expect(reads).toEqual([['m1', 'm2']]);
  });
});
