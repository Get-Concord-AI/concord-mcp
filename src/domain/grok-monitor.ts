import { z } from 'zod';

/**
 * Grok has no plugin monitor that starts on its own, and its SessionStart hook
 * output never reaches the model. The only way a Grok session starts Concord's
 * persistent monitor is the agent launching it, so the Stop hook, which sees
 * the session's background tasks, asks for it when none is running.
 */

const MONITOR_COMMAND = 'concord inbox watch';

const grokStopSchema = z.object({
  reason: z.string().optional(),
  stopHookActive: z.boolean().optional(),
  subagentType: z.string().optional(),
  backgroundTasks: z
    .array(
      z.object({
        type: z.string().optional(),
        description: z.string().optional(),
        command: z.string().optional(),
      }),
    )
    .optional(),
});

/** The monitor command for this agent. Grok's monitor tool does not pass GROK_SESSION_ID. */
export function grokMonitorCommand(agentId: string): string {
  return `${MONITOR_COMMAND} --agent ${agentId} --provider grok`;
}

/**
 * The stop feedback asking the agent to start its monitor, or undefined when
 * one is already running or this stop is not the main session ending a turn.
 */
export function grokMonitorNudge(
  rawPayload: string,
  agentId: string,
  receiverIsActive = false,
): string | undefined {
  // Grok's monitor description is free text; the live receiver lease is authoritative.
  if (receiverIsActive) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return undefined;
  }
  const result = grokStopSchema.safeParse(parsed);
  if (!result.success) return undefined;
  const stop = result.data;
  if (stop.stopHookActive === true || stop.subagentType !== undefined) return undefined;
  if (stop.reason !== undefined && stop.reason !== 'end_turn') return undefined;
  const running = (stop.backgroundTasks ?? []).some((task) =>
    [task.description, task.command].some((text) => text?.includes(MONITOR_COMMAND) === true),
  );
  if (running) return undefined;
  return (
    'Concord: this session is not watching for messages from other agents. Start a persistent ' +
    `\`monitor\` (persistent: true) for \`${grokMonitorCommand(agentId)}\`, then end your turn.`
  );
}
