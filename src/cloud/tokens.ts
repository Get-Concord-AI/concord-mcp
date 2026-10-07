import { z } from 'zod';

import { assertKeySafeUrl, type Fetch } from './client.js';
import { readCredentials, writeCredentials, type OAuthTokens } from './settings.js';

/**
 * The bearer token for Concord Cloud, whichever way this machine logged in.
 *
 * An API key is used as it is. A browser login holds a short-lived access
 * token and a refresh token; the access token is refreshed shortly before it
 * expires and the rotated pair saved, so a session that runs for days never
 * presents an expired token. Read from the credentials file on every call, so
 * a refresh by another process on this machine is picked up rather than
 * repeated.
 */
export type Bearer = () => Promise<string>;

/** Refreshed this long before expiry, so a token never expires in flight. */
const EARLY_MS = 60_000;

const TIMEOUT_MS = 15_000;

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
});

/** Exchanges a grant at a token endpoint for a fresh pair. */
export async function requestTokens(
  oauth: Pick<OAuthTokens, 'clientId' | 'tokenEndpoint'>,
  grant: Record<string, string>,
  fetchImpl: Fetch,
  now: () => number = Date.now,
): Promise<OAuthTokens> {
  assertKeySafeUrl(oauth.tokenEndpoint);
  const response = await fetchImpl(oauth.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...grant, client_id: oauth.clientId }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Concord Cloud sign-in answered ${String(response.status)}; run \`concord cloud login\` again.`,
    );
  }
  const raw: unknown = await response.json();
  const parsed = tokenResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Concord Cloud sign-in returned no usable tokens.');
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: now() + parsed.data.expires_in * 1000,
    clientId: oauth.clientId,
    tokenEndpoint: oauth.tokenEndpoint,
  };
}

export function bearerFor(
  env: NodeJS.ProcessEnv,
  fetchImpl: Fetch,
  now: () => number = Date.now,
): Bearer {
  // One refresh at a time in this process: concurrent calls share it.
  let refreshing: Promise<string> | undefined;

  return async () => {
    const credentials = readCredentials(env);
    if (credentials === undefined) {
      throw new Error('Not logged in to Concord Cloud; run `concord cloud login`.');
    }
    if ('apiKey' in credentials) return credentials.apiKey;
    if (credentials.oauth.expiresAt - now() > EARLY_MS) return credentials.oauth.accessToken;

    if (refreshing === undefined) {
      const { oauth } = credentials;
      const attempt = requestTokens(
        oauth,
        { grant_type: 'refresh_token', refresh_token: oauth.refreshToken },
        fetchImpl,
        now,
      ).then((fresh) => {
        writeCredentials(env, { apiUrl: credentials.apiUrl, oauth: fresh });
        return fresh.accessToken;
      });
      refreshing = attempt;
      attempt.then(
        () => {
          refreshing = undefined;
        },
        () => {
          refreshing = undefined;
        },
      );
    }
    return refreshing;
  };
}
