import { execFileSync } from 'node:child_process';
import { z } from 'zod';

/** How far a hook walks up to find its client: wrappers plus the client itself. */
export const CLIENT_BINDING_DEPTH = 4;
/** How far a server looks for its client: the direct parent, or one shim past it. */
export const SERVER_BINDING_DEPTH = 2;

export interface AncestorProcess {
  pid: number;
  /** Executable basename as the process table reports it, '' when unknown. */
  name: string;
}

const windowsProcessRow = z.object({
  ProcessId: z.number(),
  ParentProcessId: z.number().nullable(),
  Name: z.string(),
});

/**
 * The full Windows process table from a single powershell spawn — one WMI
 * roundtrip total. Walking per level used to spawn powershell once per
 * ancestor, and even batched inside one process it still paid one CIM query
 * per level; each query costs seconds of WMI service time on a loaded
 * machine, so hooks died past the client hook timeout and bindings were
 * never written. The chain is then walked in memory, costing nothing.
 * Undefined when the table cannot be read at all; callers degrade as before.
 */
function windowsProcessTable(): Map<number, { ppid: number; name: string }> | undefined {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress',
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const raw: unknown = JSON.parse(out.trim() === '' ? 'null' : out);
    if (raw === null) return undefined;
    // ConvertTo-Json unwraps single objects when the table has one row.
    const rows = z
      .union([z.array(windowsProcessRow), windowsProcessRow.transform((row) => [row])])
      .parse(raw);
    const table = new Map<number, { ppid: number; name: string }>();
    for (const row of rows) {
      if (row.ParentProcessId !== null) {
        table.set(row.ProcessId, { ppid: row.ParentProcessId, name: row.Name });
      }
    }
    return table.size === 0 ? undefined : table;
  } catch {
    return undefined;
  }
}

/** The parent pid and executable name of `pid`, or undefined when the table cannot say. */
function processInfo(pid: number): { ppid: number | undefined; name: string } | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /^\s*(\d+)\s+(.+)$/.exec(out.trim());
    if (match === null) return undefined;
    const parsed = Number.parseInt(match[1] ?? '', 10);
    return { ppid: Number.isFinite(parsed) ? parsed : undefined, name: match[2] ?? '' };
  } catch {
    return undefined;
  }
}

/**
 * This process's ancestors, nearest first — its own parent included — with
 * the executable name the process table reports for each. A client hook and
 * the MCP server the same client launched share the client as an ancestor,
 * but wrappers between client and hook shift the hook's ppid away from the
 * server's; the names let a hook tell wrapper shells from the client itself.
 * Best-effort: the walk stops where the process table stops.
 */
export function ancestorChain(
  limit = 4,
  ppid: number = process.ppid,
  stopAfter?: (ancestor: AncestorProcess) => boolean,
): AncestorProcess[] {
  if (process.platform === 'win32') {
    const table = windowsProcessTable();
    if (table === undefined) return [{ pid: ppid, name: '' }];
    const chain: AncestorProcess[] = [];
    let current: number | undefined = ppid;
    while (current !== undefined && current > 1 && chain.length < limit) {
      if (chain.some((ancestor) => ancestor.pid === current)) break;
      const row = table.get(current);
      const ancestor = { pid: current, name: row?.name ?? '' };
      chain.push(ancestor);
      if (stopAfter?.(ancestor) === true) break;
      current = row?.ppid;
    }
    return chain;
  }
  const chain: AncestorProcess[] = [];
  let current: number | undefined = ppid;
  while (current !== undefined && current > 1 && chain.length < limit) {
    if (chain.some((ancestor) => ancestor.pid === current)) break;
    const info = processInfo(current);
    const ancestor = { pid: current, name: info?.name ?? '' };
    chain.push(ancestor);
    if (stopAfter?.(ancestor) === true) break;
    current = info?.ppid;
  }
  return chain;
}

/** This process's ancestor pids, nearest first — the pids of ancestorChain. */
export function ancestorPids(limit = 4, ppid: number = process.ppid): number[] {
  return ancestorChain(limit, ppid).map((ancestor) => ancestor.pid);
}
