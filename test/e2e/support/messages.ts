/**
 * Every harness frames a delivered message the same way —
 * `[concord from <agent> id=<message> task=<task>]` followed by the content —
 * whatever envelope (hook JSON, monitor line, app-server turn) carries it.
 */

/** The harness channel that handed a message over. */
export type Channel =
  | 'post-tool-use'
  | 'pre-invocation'
  | 'stop'
  | 'followup'
  | 'monitor'
  | 'turn/start'
  | 'turn/steer';

export interface Delivered {
  messageId: string;
  sender: string;
  content: string;
  via: Channel;
}

const HEADER = /\[concord from (\S+) id=([^\s\]]+)(?: task=[^\]]*)?\]/gu;

export function parseDelivered(text: string, via: Channel): Delivered[] {
  const headers = [...text.matchAll(HEADER)];
  return headers.map((header, index) => {
    const start = header.index + header[0].length;
    const end = headers[index + 1]?.index ?? text.length;
    return {
      sender: header[1] ?? '',
      messageId: header[2] ?? '',
      content: text.slice(start, end).trim(),
      via,
    };
  });
}

export async function eventually<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
