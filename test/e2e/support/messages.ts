/**
 * Every harness frames a delivered message the same way —
 * `[concord from <agent> id=<message> task=<task>]` followed by the content —
 * whatever envelope (hook JSON, monitor line, app-server turn) carries it.
 */

export interface Delivered {
  messageId: string;
  sender: string;
  content: string;
}

const HEADER = /\[concord from (\S+) id=([^\s\]]+)(?: task=[^\]]*)?\]/gu;

export function parseDelivered(text: string): Delivered[] {
  const headers = [...text.matchAll(HEADER)];
  return headers.map((header, index) => {
    const start = header.index + header[0].length;
    const end = headers[index + 1]?.index ?? text.length;
    return {
      sender: header[1] ?? '',
      messageId: header[2] ?? '',
      content: text.slice(start, end).trim(),
    };
  });
}

export async function eventually<T>(
  probe: () => T | undefined,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
