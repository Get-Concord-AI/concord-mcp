import { z } from 'zod';

import { assertKeySafeUrl, sameApi, type Fetch } from './client.js';
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
export type Bearer = (signal?: AbortSignal) => Promise<string>;

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
  /** A caller with its own deadline (a hook): the request ends with it, not later. */
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  assertKeySafeUrl(oauth.tokenEndpoint);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetchImpl(oauth.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...grant, client_id: oauth.clientId }).toString(),
    signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
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
  /** The API the token is for. A login to another API is never sent here. */
  apiUrl: string,
  fetchImpl: Fetch,
  now: () => number = Date.now,
): Bearer {
  const current = () => {
    const credentials = readCredentials(env);
    if (credentials === undefined) {
      throw new Error('Not logged in to Concord Cloud; run `concord cloud login`.');
    }
    if (!sameApi(credentials.apiUrl, apiUrl)) {
      throw new Error(
        `This machine is now logged in to ${credentials.apiUrl}, not ${apiUrl}; ` +
          'restart the session to use the new login.',
      );
    }
    return credentials;
  };

  // One refresh at a time in this process: concurrent calls share it.
  let refreshing: Promise<string> | undefined;

  return async (signal) => {
    const credentials = current();
    if ('apiKey' in credentials) return credentials.apiKey;
    if (credentials.oauth.expiresAt - now() > EARLY_MS) return credentials.oauth.accessToken;

    if (refreshing === undefined) {
      const { oauth } = credentials;
      const attempt = requestTokens(
        oauth,
        { grant_type: 'refresh_token', refresh_token: oauth.refreshToken },
        fetchImpl,
        now,
        signal,
      ).then((fresh) => {
        // Saved only over the login it refreshed. Had someone logged out, or
        // in again, meanwhile, this result is theirs to discard, not to undo.
        const latest = current();
        if (!('oauth' in latest) || latest.oauth.refreshToken !== oauth.refreshToken) {
          if ('oauth' in latest && latest.oauth.expiresAt - now() > EARLY_MS) {
            return latest.oauth.accessToken;
          }
          throw new Error('The Concord Cloud login changed; run `concord cloud login`.');
        }
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
