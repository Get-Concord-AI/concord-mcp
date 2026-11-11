import { join } from 'node:path';

import { standaloneInstall } from '../config/install-mode.js';

const NPX_SERVER_ARGS = ['-y', '@concord-ai/concord-mcp'];

/** How a harness that spawns its own stdio servers should launch Concord's. */
export interface ServerLaunch {
  command: string;
  args: string[];
}

/** A standalone install has no npm, so the harness launches Concord's own launcher instead of npx. */
export function concordServerLaunch(): ServerLaunch {
  const standalone = standaloneInstall();
  return standalone === undefined
    ? { command: 'npx', args: [...NPX_SERVER_ARGS] }
    : { command: join(standalone.binDir, 'concord-mcp'), args: [] };
}
