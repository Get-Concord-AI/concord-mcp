/**
 * The verified delivery contract for every supported coding harness.
 *
 * Installation, diagnostics, endpoint registration, and generated agent
 * guidance all read this catalog. Keep harness-specific lifecycle knowledge
 * here rather than teaching each caller its own slightly different version.
 */

export const harnessNames = ['claude-code', 'codex', 'cursor', 'gemini', 'grok', 'goose'] as const;
export type HarnessName = (typeof harnessNames)[number];

export const transports = ['pull', 'local-ipc', 'app-server'] as const;
export type Transport = (typeof transports)[number];

export const reaches = ['busy', 'idle'] as const;
export type Reach = (typeof reaches)[number];

export const deliveryCapabilities = ['pull', 'inject', 'steer'] as const;
export type DeliveryCapability = (typeof deliveryCapabilities)[number];

export interface EndpointCapability {
  transport: Transport;
  reach: readonly Reach[];
  operations: readonly DeliveryCapability[];
}

export type MonitorKind = 'native-monitor' | 'managed-controller' | 'harness-monitor';

export type MonitorLifecycle = 'native' | 'managed' | 'persistent' | 'one-shot';
export type MonitorCompletion = 'native' | 'controller' | 'shell-inject';

export interface HarnessMonitorConfig {
  kind: MonitorKind;
  lifecycle: MonitorLifecycle;
  completion: MonitorCompletion;
  /** CLI command; `<agent-id>` is supplied by the harness SessionStart hook. */
  command?: string;
  /** Whether the harness should own this as a background task. */
  background: boolean;
  verified: boolean;
  /** Native shell support is separate from whether completion can wake a turn. */
  backgroundShell?: {
    supported: boolean;
    completionStartsTurn: boolean;
  };
}

export interface HarnessConfig {
  name: HarnessName;
  executable: string;
  minimumVersion: readonly [number, number, number];
  defaultCapability: EndpointCapability;
  monitorCapability: EndpointCapability;
  monitor: HarnessMonitorConfig;
  installedCapabilities: readonly string[];
  installedDetail: string;
  unsupportedDetail: string;
}

const busyPull: EndpointCapability = {
  transport: 'pull',
  reach: ['busy'],
  operations: ['pull', 'steer'],
};

const idlePull: EndpointCapability = {
  transport: 'pull',
  reach: ['busy', 'idle'],
  operations: ['pull', 'steer'],
};

const idleInject: EndpointCapability = {
  transport: 'pull',
  reach: ['busy', 'idle'],
  operations: ['pull', 'inject', 'steer'],
};

export const HARNESS_CONFIGS: Record<HarnessName, HarnessConfig> = {
  'claude-code': {
    name: 'claude-code',
    executable: 'claude',
    minimumVersion: [2, 1, 105],
    defaultCapability: idleInject,
    monitorCapability: idleInject,
    monitor: {
      kind: 'native-monitor',
      lifecycle: 'native',
      completion: 'native',
      background: true,
      verified: true,
    },
    installedCapabilities: ['pull', 'inject', 'steer', 'idle', 'busy'],
    installedDetail: 'Native plugin monitor wakes idle sessions; lifecycle hooks cover busy turns.',
    unsupportedDetail: 'Claude Code does not meet the verified plugin monitor baseline (2.1.105).',
  },
  codex: {
    name: 'codex',
    executable: 'codex',
    minimumVersion: [0, 147, 0],
    defaultCapability: busyPull,
    monitorCapability: idleInject,
    monitor: {
      kind: 'managed-controller',
      lifecycle: 'managed',
      completion: 'controller',
      background: true,
      verified: true,
      backgroundShell: { supported: true, completionStartsTurn: false },
    },
    installedCapabilities: ['pull', 'inject', 'steer', 'idle', 'busy'],
    installedDetail: 'Managed app-server controller is available for turn/start and turn/steer.',
    unsupportedDetail: 'This Codex version lacks the verified app-server steering contract.',
  },
  cursor: {
    name: 'cursor',
    executable: 'cursor',
    minimumVersion: [3, 0, 0],
    defaultCapability: busyPull,
    monitorCapability: idlePull,
    monitor: {
      kind: 'harness-monitor',
      lifecycle: 'one-shot',
      completion: 'native',
      command: 'concord inbox watch --provider cursor --once',
      background: true,
      verified: true,
      backgroundShell: { supported: true, completionStartsTurn: true },
    },
    installedCapabilities: ['pull', 'steer', 'idle', 'busy', 'monitor-command'],
    installedDetail:
      'A one-shot Cursor background Shell monitor wakes the agent with each message; lifecycle hooks register identity and provide stop-hook fallback.',
    unsupportedDetail:
      'Cursor does not meet the verified background Shell monitor baseline (3.0.0).',
  },
  gemini: {
    name: 'gemini',
    executable: 'gemini',
    minimumVersion: [0, 55, 0],
    defaultCapability: busyPull,
    monitorCapability: idlePull,
    monitor: {
      kind: 'harness-monitor',
      lifecycle: 'one-shot',
      completion: 'shell-inject',
      command: 'concord inbox watch --agent <agent-id> --provider gemini --once',
      background: true,
      verified: true,
      backgroundShell: { supported: true, completionStartsTurn: true },
    },
    installedCapabilities: ['pull', 'steer', 'idle', 'busy', 'monitor-command'],
    installedDetail:
      'A one-shot Gemini background shell monitor injects its completion into the agent; lifecycle hooks provide busy-turn fallback.',
    unsupportedDetail:
      'Gemini CLI does not meet the verified background shell injection baseline (0.55.0).',
  },
  grok: {
    name: 'grok',
    executable: 'grok',
    minimumVersion: [1, 0, 0],
    defaultCapability: busyPull,
    monitorCapability: idlePull,
    monitor: {
      kind: 'harness-monitor',
      lifecycle: 'persistent',
      completion: 'native',
      command: 'concord inbox watch --provider grok',
      background: true,
      verified: true,
      backgroundShell: { supported: true, completionStartsTurn: true },
    },
    installedCapabilities: ['pull', 'steer', 'idle', 'busy', 'monitor-command'],
    installedDetail: 'Hooks cover busy turns; a Grok persistent monitor wakes idle sessions.',
    unsupportedDetail: 'Grok Build does not meet the verified hook/monitor baseline (1.0.0).',
  },
  goose: {
    name: 'goose',
    executable: 'goose',
    minimumVersion: [1, 52, 0],
    defaultCapability: busyPull,
    monitorCapability: idlePull,
    monitor: {
      kind: 'harness-monitor',
      lifecycle: 'one-shot',
      completion: 'native',
      background: false,
      verified: false,
    },
    installedCapabilities: ['pull', 'busy'],
    installedDetail:
      'Concord MCP server is registered with Goose; durable inbox delivery is available.',
    unsupportedDetail: 'Goose does not meet the verified MCP baseline (1.52.0).',
  },
};

const fallbackCapability: EndpointCapability = {
  transport: 'pull',
  reach: ['busy'],
  operations: ['pull'],
};

export function harnessConfigFor(provider: string): HarnessConfig | undefined {
  return Object.values(HARNESS_CONFIGS).find((config) => config.name === provider);
}

export function defaultCapabilityFor(provider: string): EndpointCapability {
  return harnessConfigFor(provider)?.defaultCapability ?? fallbackCapability;
}

export function configuredMonitorCapabilityFor(provider: string): EndpointCapability {
  return (
    harnessConfigFor(provider)?.monitorCapability ?? {
      ...fallbackCapability,
      reach: ['busy', 'idle'],
    }
  );
}

export function renderHarnessMonitorInstructions(): string {
  const cursor = HARNESS_CONFIGS.cursor.monitor.command ?? '';
  const gemini = HARNESS_CONFIGS.gemini.monitor.command ?? '';
  const grok = HARNESS_CONFIGS.grok.monitor.command ?? '';
  return `In Grok Build, keep this session reachable while idle by starting one persistent
monitor for \`${grok}\`. Do not start a duplicate when that monitor is active.

In Cursor, start exactly one Cursor background Shell task for \`${cursor}\`.
Leave it active when the turn ends. When Cursor resumes you with its completion,
answer the emitted peer message and immediately start a fresh background monitor.

In Gemini CLI, start the exact monitor command supplied by the SessionStart hook
(\`${gemini}\`) with \`run_shell_command\` and \`is_background: true\`. Project
settings inject background completion into the agent. Answer the peer message,
then immediately start a fresh background monitor.`;
}
