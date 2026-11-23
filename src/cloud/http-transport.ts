import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  FetchLike,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * The SDK's Streamable HTTP client transport, as a `Transport`. Delegation
 * rather than a cast: the SDK types its `sessionId` as `string | undefined`,
 * which `exactOptionalPropertyTypes` will not accept for `sessionId?: string`.
 */
export class HttpClientTransport implements Transport {
  readonly #inner: StreamableHTTPClientTransport;

  onclose: NonNullable<Transport['onclose']> = () => undefined;
  onerror: NonNullable<Transport['onerror']> = () => undefined;
  onmessage: NonNullable<Transport['onmessage']> = () => undefined;

  constructor(url: URL, headers: Record<string, string>, fetchImpl?: FetchLike) {
    this.#inner = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
  }

  setProtocolVersion(version: string): void {
    this.#inner.setProtocolVersion(version);
  }

  async start(): Promise<void> {
    this.#inner.onclose = () => {
      this.onclose();
    };
    this.#inner.onerror = (error) => {
      this.onerror(error);
    };
    this.#inner.onmessage = (message: JSONRPCMessage) => {
      this.onmessage(message);
    };
    await this.#inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.#inner.send(message, options === undefined ? undefined : resumptionOptions(options));
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }
}

interface ResumptionOptions {
  resumptionToken?: string;
  onresumptiontoken?: (token: string) => void;
}

/**
 * The resumption fields the Streamable HTTP transport reads, with unset fields
 * left out. Its `send` types them as `resumptionToken?: string`, which
 * `exactOptionalPropertyTypes` will not fill from the generic options'
 * `string | undefined`. `relatedRequestId` is dropped: this transport never reads it.
 */
function resumptionOptions(options: TransportSendOptions): ResumptionOptions {
  return {
    ...(options.resumptionToken === undefined ? {} : { resumptionToken: options.resumptionToken }),
    ...(options.onresumptiontoken === undefined
      ? {}
      : { onresumptiontoken: options.onresumptiontoken }),
  };
}
