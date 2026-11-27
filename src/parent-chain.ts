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

const windowsChainRow = z.object({
  ProcessId: z.number(),
  Name: z.string(),
});

/**
 * The ancestor chain of `ppid` on Windows, nearest first, from a single
 * powershell spawn. One spawn per level — the naive walk — cost a shell
 * startup per ancestor, which under load pushed hook execution past the
 * client hook timeout: bindings landed late or never. Walking inside one
 * powershell process pays that startup once. Undefined when the table cannot
 * be read at all; callers degrade as before.
 */
function windowsAncestorChain(limit: number, ppid: number): AncestorProcess[] | undefined {
  try {
    const script =
      `$cur=${String(ppid)};$out=@();` +
      `for($i=0;$i -lt ${String(limit)};$i++){` +
      'if($cur -le 1){break};' +
      '$p=Get-CimInstance Win32_Process -Filter "ProcessId=$cur";' +
      'if($null -eq $p){break};' +
      '$out+=[pscustomobject]@{ProcessId=$cur;Name=$p.Name};' +
      '$cur=$p.ParentProcessId};' +
      'ConvertTo-Json -Compress -InputObject @($out)';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const raw: unknown = JSON.parse(out.trim() === '' ? 'null' : out);
    if (raw === null) return undefined;
    // ConvertTo-Json keeps array shape for -InputObject, but single-row output
    // can still arrive unwrapped depending on the powershell version.
    const rows = z
      .union([z.array(windowsChainRow), windowsChainRow.transform((row) => [row])])
      .parse(raw);
    if (rows.length === 0) return undefined;
    return rows.map((row) => ({ pid: row.ProcessId, name: row.Name }));
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
    const rows = windowsAncestorChain(limit, ppid) ?? [{ pid: ppid, name: '' }];
    const chain: AncestorProcess[] = [];
    for (const row of rows) {
      if (chain.some((ancestor) => ancestor.pid === row.pid)) break;
      chain.push(row);
      if (stopAfter?.(row) === true) break;
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
