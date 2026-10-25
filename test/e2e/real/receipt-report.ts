import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { e2eRoot } from '../support/sandbox.js';
import type { ProbeReceipt } from './session.js';

/**
 * One row per receipt scenario, appended to `.e2e/receipt-report.jsonl`, so a
 * run ends with a table of exactly what each harness did. Written before the
 * scenario asserts, so a failing case is reported too.
 */
export interface ReceiptRow {
  harness: string;
  scenario: string;
  /** Status seen in the send result itself (the sent tick). */
  atSend: string;
  /** Final receipt, or the last one seen before giving up. */
  receipt: ProbeReceipt | null;
  /** Anything the scenario observed along the way. */
  notes?: string;
}

export function recordReceipt(row: ReceiptRow): void {
  const root = e2eRoot();
  mkdirSync(root, { recursive: true });
  appendFileSync(
    join(root, 'receipt-report.jsonl'),
    `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`,
  );
}
