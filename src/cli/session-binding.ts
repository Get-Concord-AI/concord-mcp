import type { Repositories } from '../db/index.js';
import { CLIENT_BINDING_DEPTH, ancestorChain, type AncestorProcess } from '../parent-chain.js';

/**
 * Shells a harness puts between its client and a hook command — `cmd /c` on
 * Windows, `$SHELL -c` elsewhere. Anything else that spawned the hook is
 * treated as the client itself; a wrapper a caller did not list simply ends
 * the walk there and the binding degrades to the environment identity.
 */
const SHELL_WRAPPER_NAMES: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'nu',
  'xonsh',
  'busybox',
  'cmd',
  'command',
  'powershell',
  'pwsh',
]);

/** Whether `name` is a wrapper shell rather than the client hosting the session. */
export function isShellWrapper(name: string): boolean {
  return SHELL_WRAPPER_NAMES.has(
    name
      .trim()
      .toLowerCase()
      .replace(/^.*[\\/]/, '')
      .replace(/^-/, '')
      .replace(/\.exe$/, ''),
  );
}

/**
 * The pids a hook may bind: wrapper shells plus the first ancestor that is
 * not one — the client itself. The walk stops there on purpose: binding
 * deeper pids would stamp this session's agent on the client's own parent,
 * which may be another client hosting a different session.
 */
export function bindingTargetPids(ancestors: readonly AncestorProcess[]): number[] {
  const pids: number[] = [];
  for (const ancestor of ancestors) {
    pids.push(ancestor.pid);
    if (!isShellWrapper(ancestor.name)) break;
  }
  return pids;
}

/**
 * Kinds whose MCP server never holds an environment identity, so a recorded
 * binding can never be adopted (`liveSessionIdentity` needs an env identity
 * to correct). Walking the process table and writing rows for them is pure
 * overhead — on Windows each lookup is a powershell spawn per hook fire.
 */
const BINDINGLESS_KINDS: ReadonlySet<string> = new Set(['codex', 'hermes']);

/**
 * Record that this hook's client hosts `identity` — the client pid and any
 * wrapper shells below it, so a shell between client and hook still leaves
 * the binding where the client's MCP servers can see it. The rows are
 * rewritten on every session-start fire: rows this agent left for older hook
 * shells (a returning session after A → B → A) are dropped first, so only
 * the current client's lineage points at it.
 */
export function recordClientBinding(
  repos: Repositories,
  identity: { agentId: string; kind: string },
  ancestors?: readonly AncestorProcess[],
): void {
  if (BINDINGLESS_KINDS.has(identity.kind)) return;
  const chain =
    ancestors ??
    // Stop the walk at the first non-shell ancestor instead of always
    // climbing CLIENT_BINDING_DEPTH levels that bindingTargetPids would
    // discard anyway.
    ancestorChain(CLIENT_BINDING_DEPTH, process.ppid, (a) => !isShellWrapper(a.name));
  const at = new Date().toISOString();
  repos.sessionBindings.removeForAgent(identity.agentId);
  for (const pid of bindingTargetPids(chain)) {
    repos.sessionBindings.upsert(pid, identity.agentId, identity.kind, at);
  }
}
