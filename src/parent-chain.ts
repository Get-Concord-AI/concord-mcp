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
  ParentProcessId: z.number().nullable(),
  Name: z.string(),
});

/** The parent pid and executable name of `pid`, or undefined when the table cannot say. */
function processInfo(pid: number): { ppid: number | undefined; name: string } | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}") | Select-Object ParentProcessId,Name | ConvertTo-Json -Compress`,
        ],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const raw: unknown = JSON.parse(out.trim() === '' ? 'null' : out);
      const row = windowsProcessRow.nullable().parse(raw);
      if (row === null) return undefined;
      return { ppid: row.ParentProcessId ?? undefined, name: row.Name };
    }
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
