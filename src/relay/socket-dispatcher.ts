import { createConnection } from 'node:net';

import { renderPeerMessage } from '../domain/pull-inbox.js';
import type { AgentMessageDispatcher, DeliveryReceipt } from '../tools/agent-messages.js';
import {
  decodeRelayResponse,
  encodeRelayFrame,
  MAX_RELAY_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
} from './protocol.js';

export class SocketAgentMessageDispatcher implements AgentMessageDispatcher {
  constructor(private readonly connectTimeoutMs = 1_500) {}

  deliver(request: Parameters<AgentMessageDispatcher['deliver']>[0]): Promise<DeliveryReceipt> {
    if (request.endpoint.transport !== 'local-ipc') {
      return Promise.reject(
        new Error(`Unsupported relay transport: ${request.endpoint.transport}`),
      );
    }

    return new Promise((resolve, reject) => {
      const socket = createConnection(request.endpoint.address);
      let settled = false;
      let buffer = '';
      const timer = setTimeout(() => {
        finish(new Error('relay connection timed out'));
        socket.destroy();
      }, this.connectTimeoutMs);

      const finish = (error?: Error, receipt?: DeliveryReceipt): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error !== undefined) reject(error);
        else if (receipt !== undefined) resolve(receipt);
      };

      socket.once('error', (error) => {
        finish(error);
      });
      socket.once('connect', () => {
        socket.write(
          encodeRelayFrame({
            version: RELAY_PROTOCOL_VERSION,
            type: 'deliver',
            messageId: request.message.messageId,
            senderAgentId: request.message.senderAgentId,
            recipientAgentId: request.message.recipientAgentId,
            credentialProof: request.endpoint.credentialHash,
            // Framed as every other channel frames it (a cloud host frames its
            // own), so the session knows who wrote and which id to answer.
            content: renderPeerMessage(request.message),
          }),
        );
      });
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer, 'utf8') > MAX_RELAY_FRAME_BYTES) {
          finish(new Error('relay response exceeded maximum frame size'));
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const response = decodeRelayResponse(buffer.slice(0, newline));
          if (!response.ok) {
            finish(new Error(response.error));
            return;
          }
          finish(undefined, {
            provider: response.provider,
            delivery: response.delivery,
            ...(response.receipt === undefined ? {} : { receipt: response.receipt }),
          });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once('end', () => {
        if (!settled) finish(new Error('relay closed without a delivery receipt'));
      });
    });
  }
}
