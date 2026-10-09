import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Fetch } from '../../src/cloud/client.js';
import {
  readCredentials,
  removeCredentials,
  writeCredentials,
  type OAuthTokens,
} from '../../src/cloud/settings.js';
import { bearerFor } from '../../src/cloud/tokens.js';

const NOW = 1_800_000_000_000;
const API = 'https://api.concord.test';

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: NOW + 3_600_000,
    clientId: 'cli-client',
    tokenEndpoint: 'https://auth.concord.test/auth/v1/oauth/token',
    ...overrides,
  };
}

/** A token endpoint that rotates the pair each time, recording what it was sent. */
function tokenEndpoint(status = 200): { fetch: Fetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetch: Fetch = (_input, init) => {
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    const n = String(bodies.length + 1);
    return Promise.resolve(
      status === 200
        ? Response.json({
            access_token: `access-${n}`,
            refresh_token: `refresh-${n}`,
            expires_in: 3600,
          })
        : new Response('{"error":"invalid_grant"}', { status }),
    );
  };
  return { fetch, bodies };
}

describe('bearerFor', () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    env = { HOME: mkdtempSync(join(tmpdir(), 'concord-tokens-')) };
  });

  it('uses an API key as it is', async () => {
    writeCredentials(env, { apiUrl: API, apiKey: 'cak_key' });
    expect(await bearerFor(env, API, tokenEndpoint().fetch, () => NOW)()).toBe('cak_key');
  });

  it('uses a current access token without asking for another', async () => {
    writeCredentials(env, { apiUrl: API, oauth: tokens() });
    const endpoint = tokenEndpoint();
    expect(await bearerFor(env, API, endpoint.fetch, () => NOW)()).toBe('access-1');
    expect(endpoint.bodies).toEqual([]);
  });

  it('refreshes shortly before expiry, and saves the rotated pair', async () => {
    writeCredentials(env, { apiUrl: API, oauth: tokens({ expiresAt: NOW + 30_000 }) });
    const endpoint = tokenEndpoint();

    expect(await bearerFor(env, API, endpoint.fetch, () => NOW)()).toBe('access-2');
    const sent = new URLSearchParams(endpoint.bodies[0]);
    expect(Object.fromEntries(sent)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'cli-client',
    });

    const saved = readCredentials(env);
    expect(saved !== undefined && 'oauth' in saved ? saved.oauth : undefined).toEqual(
      tokens({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: NOW + 3_600_000 }),
    );
  });

  it('shares one refresh between concurrent requests', async () => {
    writeCredentials(env, { apiUrl: API, oauth: tokens({ expiresAt: NOW }) });
    const endpoint = tokenEndpoint();
    const bearer = bearerFor(env, API, endpoint.fetch, () => NOW);

    expect(await Promise.all([bearer(), bearer(), bearer()])).toEqual([
      'access-2',
      'access-2',
      'access-2',
    ]);
    expect(endpoint.bodies).toHaveLength(1);
  });

  it('says to log in again when a refresh is refused, and tries again next time', async () => {
    writeCredentials(env, { apiUrl: API, oauth: tokens({ expiresAt: NOW }) });
    const refused = tokenEndpoint(400);
    const bearer = bearerFor(env, API, refused.fetch, () => NOW);

    await expect(bearer()).rejects.toThrow(/concord cloud login/);
    await expect(bearer()).rejects.toThrow(/concord cloud login/);
    expect(refused.bodies).toHaveLength(2);
  });

  it('never sends a token to an API other than the one it was asked for', async () => {
    writeCredentials(env, { apiUrl: API, apiKey: 'cak_key' });
    const bearer = bearerFor(env, API, tokenEndpoint().fetch, () => NOW);
    expect(await bearer()).toBe('cak_key');

    // Logged in elsewhere while this session was running.
    writeCredentials(env, { apiUrl: 'https://other.concord.test', apiKey: 'cak_other' });
    await expect(bearer()).rejects.toThrow(/restart the session/);
  });

  it('discards a refresh that finishes after a logout', async () => {
    writeCredentials(env, { apiUrl: API, oauth: tokens({ expiresAt: NOW }) });
    const loggingOut: Fetch = (input, init) => {
      removeCredentials(env);
      return tokenEndpoint().fetch(input, init);
    };

    await expect(bearerFor(env, API, loggingOut, () => NOW)()).rejects.toThrow(/Not logged in/);
    expect(readCredentials(env)).toBeUndefined();
  });

  it('keeps a new login made while a refresh was in flight', async () => {
    writeCredentials(env, { apiUrl: API, oauth: tokens({ expiresAt: NOW }) });
    const loggingInAgain: Fetch = (input, init) => {
      writeCredentials(env, {
        apiUrl: API,
        oauth: tokens({ accessToken: 'new-login', refreshToken: 'new-refresh' }),
      });
      return tokenEndpoint().fetch(input, init);
    };

    expect(await bearerFor(env, API, loggingInAgain, () => NOW)()).toBe('new-login');
    const saved = readCredentials(env);
    expect(saved !== undefined && 'oauth' in saved ? saved.oauth.refreshToken : undefined).toBe(
      'new-refresh',
    );
  });

  it('never sends a refresh token over plain http', async () => {
    writeCredentials(env, {
      apiUrl: API,
      oauth: tokens({ expiresAt: NOW, tokenEndpoint: 'http://auth.concord.test/token' }),
    });
    const endpoint = tokenEndpoint();
    await expect(bearerFor(env, API, endpoint.fetch, () => NOW)()).rejects.toThrow(/not https/);
    expect(endpoint.bodies).toEqual([]);
  });

  it('ends a refresh with the caller’s deadline, rather than keeping the process waiting', async () => {
    writeCredentials(env, { apiUrl: API, oauth: tokens({ expiresAt: NOW }) });
    let aborted = false;
    const hanging: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });

    await expect(bearerFor(env, API, hanging, () => NOW)(AbortSignal.timeout(50))).rejects.toThrow(
      'aborted',
    );
    expect(aborted).toBe(true);
  });
});
