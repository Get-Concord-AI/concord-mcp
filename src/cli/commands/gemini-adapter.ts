import { executablePath } from '../../install/adapters/index.js';
import { runInteractive } from '../../install/spawn-command.js';

/**
 * Gemini CLI reachable from its first moment.
 *
 * Gemini wakes an idle agent only when a background shell command the agent
 * started itself completes, so neither a hook nor the extension can start
 * Concord's one-shot inbox monitor on the agent's behalf. The SessionStart
 * hook tells the model to start it, but the model only acts on its first turn:
 * until the user types something, a fresh session has no monitor and cannot be
 * reached while idle. `concord adapters gemini` starts Gemini with that first
 * turn already given (`-i`), so the monitor is running before the user types.
 */

/** The opening turn: start the monitor the SessionStart hook named. */
export const GEMINI_MONITOR_PROMPT =
  'Start the Concord inbox monitor that the SessionStart hook told you about, in the background.';

/** Gemini flags that already give the session its first prompt. */
const PROMPT_FLAGS: readonly string[] = ['-i', '--prompt-interactive', '-p', '--prompt'];

function suppliesPrompt(arg: string): boolean {
  return PROMPT_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * The command line for one launched Gemini session. A prompt of the user's own
 * (`-i`, or headless `-p`) is left as given, never replaced: the monitor then
 * starts only if the agent is asked to.
 */
export function geminiLaunchPlan(args: readonly string[]): {
  args: string[];
  startsMonitor: boolean;
} {
  if (args.some(suppliesPrompt)) return { args: [...args], startsMonitor: false };
  return { args: ['-i', GEMINI_MONITOR_PROMPT, ...args], startsMonitor: true };
}

/** Run Gemini CLI with the monitor started on its first turn. */
export async function launchGemini(args: readonly string[]): Promise<void> {
  const executable = executablePath('gemini', process.env);
  if (executable === undefined) throw new Error('Gemini CLI was not found on PATH.');
  const plan = geminiLaunchPlan(args);
  if (!plan.startsMonitor) {
    process.stderr.write(
      'Concord: Gemini was given its own prompt, so the inbox monitor will not start ' +
        'on its own. Ask the agent to start it to receive messages while idle.\n',
    );
  }
  const code = await runInteractive(executable, plan.args, process.env);
  if (code !== 0) process.exitCode = code;
}
