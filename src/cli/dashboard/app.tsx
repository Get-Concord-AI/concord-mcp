import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';

import type { PresenceEntry } from '../../domain/presence.js';
import type { DashboardSnapshot, DashboardTask } from './model.js';

type Pane = 'agents' | 'tasks' | 'alerts' | 'context' | 'timeline';
type Layout = 'wide' | 'stacked' | 'compact';

export interface DashboardAppProps {
  initialSnapshot: DashboardSnapshot;
  loadSnapshot: () => DashboardSnapshot;
  refreshMs?: number;
  width?: number;
  height?: number;
}

interface PanelProps {
  title: string;
  focused: boolean;
  children: ReactNode;
  height?: number | string;
}

function Panel({ title, focused, children, height }: PanelProps): ReactNode {
  return (
    <Box
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      flexDirection="column"
      height={height}
      overflow="hidden"
      paddingX={1}
    >
      <Text bold color={focused ? 'cyan' : 'gray'}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

function layoutFor(columns: number): Layout {
  if (columns >= 100) {
    return 'wide';
  }
  if (columns >= 70) {
    return 'stacked';
  }
  return 'compact';
}

function panesFor(layout: Layout): Pane[] {
  return layout === 'compact'
    ? ['tasks', 'alerts', 'timeline']
    : ['agents', 'tasks', 'alerts', 'context', 'timeline'];
}

function ageLabel(seconds: number): string {
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  return `${String(Math.floor(seconds / 60))}m`;
}

function livenessMarker(entry: PresenceEntry): ReactNode {
  if (entry.liveness === 'live') {
    return <Text color="green">●</Text>;
  }
  if (entry.liveness === 'idle') {
    return <Text color="yellow">◐</Text>;
  }
  return <Text color="red">○</Text>;
}

function Agents({ snapshot }: { snapshot: DashboardSnapshot }): ReactNode {
  if (snapshot.status.presence.length === 0) {
    return <Text dimColor>No registered agents</Text>;
  }
  return snapshot.status.presence.map((agent) => (
    <Text key={agent.agentId} wrap="truncate-end">
      {livenessMarker(agent)} {agent.agentId} · {agent.status} · {ageLabel(agent.ageSeconds)}
      {agent.summary === null ? '' : ` · ${agent.summary}`}
    </Text>
  ));
}

function taskMatches(item: DashboardTask, filter: string): boolean {
  if (filter === '') {
    return true;
  }
  const haystack = [
    item.task.taskId,
    item.task.title,
    item.task.agent ?? '',
    item.task.owner ?? '',
    item.touches,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(filter.toLowerCase());
}

function Tasks({
  tasks,
  selectedIndex,
}: {
  tasks: DashboardTask[];
  selectedIndex: number;
}): ReactNode {
  if (tasks.length === 0) {
    return <Text dimColor>No matching tasks</Text>;
  }
  return tasks.map((item, index) => {
    const selected = index === selectedIndex;
    return (
      <Text key={item.task.taskId} color={selected ? 'cyan' : 'white'} wrap="truncate-end">
        {selected ? '›' : ' '} {item.task.taskId} · {item.task.status} ·{' '}
        {item.task.agent ?? 'unassigned'} · {item.task.title}
      </Text>
    );
  });
}

function alertLines(snapshot: DashboardSnapshot): ReactNode[] {
  const lines: ReactNode[] = [];
  for (const overlap of snapshot.status.overlaps) {
    lines.push(
      <Text key={`overlap-${overlap.a}-${overlap.b}`} color="yellow" wrap="truncate-end">
        ! {overlap.a} ↔ {overlap.b}: {overlap.reasons.join('; ')}
      </Text>,
    );
  }
  for (const claim of snapshot.status.staleClaims) {
    lines.push(
      <Text key={`stale-${claim.taskId}`} color="red" wrap="truncate-end">
        ! {claim.taskId}: stale claim by {claim.agentId}
      </Text>,
    );
  }
  for (const question of snapshot.status.openQuestions) {
    lines.push(
      <Text
        key={`question-${question.taskId}-${question.question}`}
        color="magenta"
        wrap="truncate-end"
      >
        ? {question.taskId}: {question.question}
      </Text>,
    );
  }
  for (const event of snapshot.events.filter((item) => item.status === 'error')) {
    lines.push(
      <Text key={`event-${String(event.id)}`} color="red" wrap="truncate-end">
        × {event.taskId ?? 'workspace'}: {event.tool} failed
      </Text>,
    );
  }
  return lines;
}

function Alerts({ snapshot }: { snapshot: DashboardSnapshot }): ReactNode {
  const lines = alertLines(snapshot);
  return lines.length === 0 ? <Text dimColor>No coordination alerts</Text> : lines;
}

function Context({ item }: { item: DashboardTask | undefined }): ReactNode {
  if (item === undefined) {
    return <Text dimColor>Select a task to inspect its shared memory</Text>;
  }
  return (
    <>
      <Text bold>
        {item.task.taskId} — {item.task.title}
      </Text>
      <Text wrap="truncate-end">
        owner {item.task.owner ?? '-'} · branch {item.task.branch ?? '-'} · touches {item.touches}
      </Text>
      {item.updates.slice(-5).map((update) => (
        <Text key={`update-${String(update.id)}`} wrap="truncate-end">
          <Text color={update.kind === 'decision' ? 'green' : 'blue'}>{update.kind}</Text>{' '}
          {update.content}
        </Text>
      ))}
      {item.latestHandoff === undefined ? null : (
        <Text wrap="truncate-end">
          <Text color="yellow">handoff</Text> {item.latestHandoff.whatChanged}
        </Text>
      )}
      {item.latestReview === undefined ? null : (
        <Text wrap="truncate-end">
          <Text color="magenta">review</Text> {item.latestReview.planSummary}
        </Text>
      )}
    </>
  );
}

function shortTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '--:--'
    : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function Timeline({
  snapshot,
  filter,
}: {
  snapshot: DashboardSnapshot;
  filter: string;
}): ReactNode {
  const events = snapshot.events
    .filter((event) => {
      if (filter === '') {
        return true;
      }
      return [event.taskId ?? '', event.tool, event.detail ?? '']
        .join(' ')
        .toLowerCase()
        .includes(filter.toLowerCase());
    })
    .slice(0, 8);
  if (events.length === 0) {
    return <Text dimColor>No matching activity</Text>;
  }
  return events.map((event) => (
    <Text key={event.id} color={event.status === 'error' ? 'red' : 'white'} wrap="truncate-end">
      {shortTime(event.createdAt)} · {event.taskId ?? 'workspace'} · {event.tool}
      {event.detail === null ? '' : ` · ${event.detail}`}
    </Text>
  ));
}

function Help(): ReactNode {
  return (
    <Panel title="Keyboard help" focused>
      <Text>Tab/Shift-Tab pane · ↑↓ or j/k select task · / filter · r refresh</Text>
      <Text>? close help · q or Ctrl-C quit · Esc clear filter</Text>
    </Panel>
  );
}

function DashboardBody({
  snapshot,
  layout,
  pane,
  tasks,
  selectedIndex,
  filter,
  height,
}: {
  snapshot: DashboardSnapshot;
  layout: Layout;
  pane: Pane;
  tasks: DashboardTask[];
  selectedIndex: number;
  filter: string;
  height: number;
}): ReactNode {
  const selected = tasks[selectedIndex];
  if (layout === 'compact') {
    return (
      <Box flexDirection="column" height={height} overflow="hidden">
        <Panel title="Tasks" focused={pane === 'tasks'} height="35%">
          <Tasks tasks={tasks} selectedIndex={selectedIndex} />
        </Panel>
        <Panel title="Alerts" focused={pane === 'alerts'} height="25%">
          <Alerts snapshot={snapshot} />
        </Panel>
        <Panel title="Timeline" focused={pane === 'timeline'} height="40%">
          <Timeline snapshot={snapshot} filter={filter} />
        </Panel>
      </Box>
    );
  }

  const overview = (
    <Box flexDirection="column" height="100%" overflow="hidden">
      <Panel title="Agents" focused={pane === 'agents'} height="65%">
        <Agents snapshot={snapshot} />
      </Panel>
      <Panel title="Alerts" focused={pane === 'alerts'} height="35%">
        <Alerts snapshot={snapshot} />
      </Panel>
    </Box>
  );
  const work = (
    <Box flexDirection="column" height="100%" overflow="hidden">
      <Panel title="Tasks" focused={pane === 'tasks'} height="40%">
        <Tasks tasks={tasks} selectedIndex={selectedIndex} />
      </Panel>
      <Panel title="Task context" focused={pane === 'context'} height="60%">
        <Context item={selected} />
      </Panel>
    </Box>
  );

  if (layout === 'stacked') {
    return (
      <Box flexDirection="column" height={height} overflow="hidden">
        <Panel title="Agents" focused={pane === 'agents'} height="18%">
          <Agents snapshot={snapshot} />
        </Panel>
        <Panel title="Tasks" focused={pane === 'tasks'} height="20%">
          <Tasks tasks={tasks} selectedIndex={selectedIndex} />
        </Panel>
        <Panel title="Alerts" focused={pane === 'alerts'} height="18%">
          <Alerts snapshot={snapshot} />
        </Panel>
        <Panel title="Task context" focused={pane === 'context'} height="24%">
          <Context item={selected} />
        </Panel>
        <Panel title="Timeline" focused={pane === 'timeline'} height="20%">
          <Timeline snapshot={snapshot} filter={filter} />
        </Panel>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box flexDirection="row" height="68%" overflow="hidden">
        <Box flexDirection="column" width="35%" overflow="hidden">
          {overview}
        </Box>
        <Box flexDirection="column" width="65%" overflow="hidden">
          {work}
        </Box>
      </Box>
      <Panel title="Timeline" focused={pane === 'timeline'} height="32%">
        <Timeline snapshot={snapshot} filter={filter} />
      </Panel>
    </Box>
  );
}

export function DashboardApp({
  initialSnapshot,
  loadSnapshot,
  refreshMs = 1_000,
  width,
  height,
}: DashboardAppProps): ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [terminalWidth, setTerminalWidth] = useState(width ?? stdout.columns);
  const [terminalHeight, setTerminalHeight] = useState(height ?? Math.max(8, stdout.rows));
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [paneIndex, setPaneIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState('');
  const [searching, setSearching] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const layout = layoutFor(width ?? terminalWidth);
  const viewportHeight = height ?? terminalHeight;
  const panes = panesFor(layout);
  const pane = panes[paneIndex % panes.length] ?? 'tasks';
  const tasks = useMemo(
    () => snapshot.tasks.filter((task) => taskMatches(task, filter)),
    [filter, snapshot.tasks],
  );

  const refresh = useCallback(() => {
    try {
      setSnapshot(loadSnapshot());
      setError(undefined);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [loadSnapshot]);

  useEffect(() => {
    const timer = setInterval(refresh, refreshMs);
    return () => {
      clearInterval(timer);
    };
  }, [refresh, refreshMs]);

  useEffect(() => {
    if (width !== undefined && height !== undefined) {
      return;
    }
    const resize = (): void => {
      if (width === undefined) {
        setTerminalWidth(stdout.columns);
      }
      if (height === undefined) {
        setTerminalHeight(Math.max(8, stdout.rows));
      }
    };
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
  }, [height, stdout, width]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, tasks.length - 1)));
  }, [tasks.length]);

  useInput((input, key) => {
    if (showHelp) {
      if (input === '?' || input === 'q' || key.escape) {
        setShowHelp(false);
      }
      return;
    }
    if (searching) {
      if (key.escape || key.return) {
        setSearching(false);
      } else if (key.backspace || key.delete) {
        setFilter((current) => current.slice(0, -1));
      } else if (!key.ctrl && !key.meta && input !== '') {
        setFilter((current) => current + input);
      }
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    } else if (input === '?') {
      setShowHelp(true);
    } else if (input === '/') {
      setSearching(true);
    } else if (key.escape) {
      setFilter('');
    } else if (input === 'r') {
      refresh();
    } else if (key.tab) {
      setPaneIndex((current) => {
        const direction = key.shift ? -1 : 1;
        return (current + direction + panes.length) % panes.length;
      });
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex((current) => Math.min(current + 1, Math.max(0, tasks.length - 1)));
    } else if (key.upArrow || input === 'k') {
      setSelectedIndex((current) => Math.max(0, current - 1));
    }
  });

  return (
    <Box flexDirection="column" height={viewportHeight} overflow="hidden">
      <Box justifyContent="space-between" height={1}>
        <Text bold color="cyan">
          Concord · {snapshot.repoName} · LIVE
        </Text>
        <Text dimColor>updated {shortTime(snapshot.generatedAt)}</Text>
      </Box>
      {showHelp ? (
        <Box height={Math.max(1, viewportHeight - 2)} overflow="hidden">
          <Help />
        </Box>
      ) : (
        <DashboardBody
          snapshot={snapshot}
          layout={layout}
          pane={pane}
          tasks={tasks}
          selectedIndex={selectedIndex}
          filter={filter}
          height={Math.max(1, viewportHeight - 2)}
        />
      )}
      <Box height={1} overflow="hidden">
        {error === undefined ? (
          <Text color={searching ? 'cyan' : 'gray'}>
            {searching
              ? `Filter: ${filter}▌`
              : filter === ''
                ? layout === 'compact'
                  ? 'q quit · / filter · ? help · widen for agent context'
                  : 'q quit · Tab pane · / filter · ? help'
                : `Filter: ${filter} · Esc clear`}
          </Text>
        ) : (
          <Text color="red">Refresh failed: {error}</Text>
        )}
      </Box>
    </Box>
  );
}
