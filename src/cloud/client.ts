import { z } from 'zod';

/**
 * The few Concord Cloud calls cloud mode needs before it can rely on the API:
 * what the API supports, and whether a key works.
 */

/** The API version this runtime speaks. Bumped only on incompatible change. */
export const SUPPORTED_API_VERSION = 1;

/**
 * Capabilities cloud mode relies on. Checked by name rather than by version, so
 * an API that gains capabilities never breaks an older runtime.
 */
export const REQUIRED_CAPABILITIES = [
  'projects',
  'agents-per-machine',
  'claims-check',
  'receiver-lease',
  'message-drain-wait',
] as const;

const cliLoginSchema = z.object({
  authorizationEndpoint: z.url(),
  tokenEndpoint: z.url(),
  clientId: z.string().min(1),
  redirectUri: z.url(),
});
/** How this API signs a person in from the CLI, when it offers browser login. */
export type CliLogin = z.infer<typeof cliLoginSchema>;

const metaSchema = z.object({
  apiVersion: z.number().int(),
  capabilities: z.array(z.string()),
  mcp: z.object({ endpoint: z.string(), tools: z.array(z.string()) }),
  cliLogin: cliLoginSchema.optional(),
});
export type CloudMeta = z.infer<typeof metaSchema>;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** How long any of these calls may take: a cold Cloud Run start is the slow case. */
export const TIMEOUT_MS = 15_000;

/** Whether two API URLs name the same API: spelling aside, the same endpoint. */
export function sameApi(first: string, second: string): boolean {
  const normal = (apiUrl: string): string => new URL(apiUrl).href.replace(/\/+$/, '');
  return normal(first) === normal(second);
}

/** A path on an API, however its URL is spelled. */
export function url(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * Refuses to send a key anywhere but https, or plain http to this machine for
 * local development: anyone on the path of a remote http request could read it.
 */
export function assertKeySafeUrl(apiUrl: string): void {
  const { protocol, hostname } = new URL(apiUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  if (protocol !== 'https:' && !(protocol === 'http:' && loopback)) {
    throw new Error(`${apiUrl} is not https; Concord sends an API key only over https.`);
  }
}

/** A server's error body, as one short line. */
export async function errorDetail(response: Response): Promise<string> {
  return (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** `GET /v1/meta` — public, so it answers before any key is trusted. */
export async function fetchMeta(apiUrl: string, fetchImpl: Fetch = fetch): Promise<CloudMeta> {
  const response = await fetchImpl(url(apiUrl, '/v1/meta'), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `${apiUrl} answered ${String(response.status)} to /v1/meta; is it Concord Cloud?`,
    );
  }
  const raw: unknown = await response.json();
  const parsed = metaSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${apiUrl} does not describe itself as Concord Cloud does.`);
  }
  return parsed.data;
}

/** Why this runtime cannot use an API, or null when it can. */
export function incompatibility(meta: CloudMeta): string | null {
  if (meta.apiVersion !== SUPPORTED_API_VERSION) {
    return (
      `the API speaks version ${String(meta.apiVersion)}, this runtime version ` +
      `${String(SUPPORTED_API_VERSION)}; update @concord-ai/concord-mcp`
    );
  }
  const missing = REQUIRED_CAPABILITIES.filter((name) => !meta.capabilities.includes(name));
  return missing.length === 0 ? null : `the API lacks ${missing.join(', ')}`;
}

/** Whether a key is accepted: one cheap authenticated read. */
export async function checkKey(
  apiUrl: string,
  bearer: string,
  fetchImpl: Fetch = fetch,
): Promise<'ok' | 'rejected'> {
  assertKeySafeUrl(apiUrl);
  const response = await fetchImpl(url(apiUrl, '/v1/machines'), {
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) return 'rejected';
  if (!response.ok) {
    throw new Error(`${apiUrl} answered ${String(response.status)} while checking the key.`);
  }
  return 'ok';
}

export interface MachineRegistration {
  readonly machineKey: string;
  readonly name: string;
  readonly hostname: string;
  readonly platform: string;
  readonly runtimeVersion: string;
}

/**
 * `POST /v1/machines` — registers this machine, idempotently by key. The cloud
 * refuses calls naming a machine it has not registered, so login does this.
 */
export async function registerMachine(
  apiUrl: string,
  apiKey: string,
  machine: MachineRegistration,
  fetchImpl: Fetch = fetch,
): Promise<'ok' | 'rejected'> {
  assertKeySafeUrl(apiUrl);
  const response = await fetchImpl(url(apiUrl, '/v1/machines'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(machine),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401) return 'rejected';
  if (!response.ok) {
    throw new Error(
      `${apiUrl} answered ${String(response.status)} registering this machine: ${await errorDetail(response)}`,
    );
  }
  return 'ok';
}
