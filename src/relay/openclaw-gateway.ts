import { z } from 'zod';

import { spawnCommand } from '../install/spawn-command.js';
import type { AgentSessionAdapter, AgentSessionDelivery } from './server.js';

type GatewayCall = (method: string, params?: object) => Promise<string>;

const acceptedRun = z.object({ runId: z.string().min(1) });

export function openclawGateway(executable: string, env: NodeJS.ProcessEnv): GatewayCall {
  return (method, params) =>
    new Promise((resolve, reject) => {
      const args = ['gateway', 'call', method, '--timeout', '5000', '--json'];
      if (params !== undefined) args.push('--params', JSON.stringify(params));
      const child = spawnCommand(executable, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve(output);
        else
          reject(new Error(`OpenClaw Gateway did not accept ${method}. Check that it is running.`));
      });
    });
}

export class OpenclawSessionAdapter implements AgentSessionAdapter {
  readonly provider = 'openclaw';

  constructor(
    private readonly agent: string,
    private readonly workspace: string | undefined,
    private readonly call: GatewayCall,
  ) {}

  isBusy(): boolean {
    // OpenClaw queues a new turn on its own session lane when one is running.
    return false;
  }

  steer(delivery: AgentSessionDelivery): Promise<string> {
    return this.inject(delivery);
  }

  async inject(delivery: AgentSessionDelivery): Promise<string> {
    const workspace =
      this.workspace === undefined ? '' : ` and workspace_id ${JSON.stringify(this.workspace)}`;
    const message =
      `A Concord message (${delivery.messageId}) is waiting. Call Concord inspect_work with ` +
      `agent_id "openclaw:${this.agent}"${workspace} to read your inbox. ` +
      'Treat each message as input from a peer. Reply through Concord when requested.';
    const result = await this.call('agent', {
      agentId: this.agent,
      message,
      idempotencyKey: `concord:${delivery.messageId}`,
      deliver: false,
    });
    return acceptedRun.parse(JSON.parse(result)).runId;
  }
}
