import { execFileSync } from 'node:child_process';

/** The parent pid of `pid`, or undefined when the process table cannot say. */
function parentPid(pid: number): number | undefined {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").ParentProcessId`,
            ],
            { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
          )
        : execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
    const parsed = Number.parseInt(out.trim(), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This process's ancestor pids, nearest first — its own parent included. A
 * client hook and the MCP server the same client launched share the client as
 * an ancestor, but a shell between client and hook shifts the hook's ppid
 * away from the server's; recording the chain makes the binding robust to
 * that wrap. Best-effort: the walk stops where the process table stops.
 */
export function ancestorPids(limit = 4, ppid: number = process.ppid): number[] {
  const chain: number[] = [];
  let current: number | undefined = ppid;
  while (current !== undefined && current > 1 && chain.length < limit && !chain.includes(current)) {
    chain.push(current);
    current = parentPid(current);
  }
  return chain;
}
