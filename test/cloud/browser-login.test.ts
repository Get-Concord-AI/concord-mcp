import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { browserLogin, type BrowserLoginDeps } from '../../src/cloud/browser-login.js';
import type { CliLogin, Fetch } from '../../src/cloud/client.js';

const LOGIN: CliLogin = {
  authorizationEndpoint: 'https://auth.concord.test/auth/v1/oauth/authorize',
  tokenEndpoint: 'https://auth.concord.test/auth/v1/oauth/token',
  clientId: 'cli-client',
  redirectUri: 'https://app.concord.test/cli/callback',
};

/**
 * A token endpoint that, like the real one, issues tokens only for the code it
 * handed out and the verifier whose hash was the challenge.
 */
function tokenEndpoint(expectedCode: string, challenge: () => string | undefined): Fetch {
  return (_input, init) => {
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const verifier = form.get('code_verifier') ?? '';
    const valid =
      form.get('grant_type') === 'authorization_code' &&
      form.get('code') === expectedCode &&
      form.get('redirect_uri') === LOGIN.redirectUri &&
      form.get('client_id') === LOGIN.clientId &&
      createHash('sha256').update(verifier).digest('base64url') === challenge();
    return Promise.resolve(
      valid
        ? Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
        : new Response('{"error":"invalid_grant"}', { status: 400 }),
    );
  };
}

/** Deps whose "browser" is the web page: it calls back with `respond(state)`. */
function browser(
  respond: (state: string) => string,
  sent: { url?: URL },
): Omit<BrowserLoginDeps, 'fetch'> {
  return {
    openUrl: (url) => {
      const authorize = new URL(url);
      sent.url = authorize;
      const state = authorize.searchParams.get('state') ?? '';
      const port = state.split('.')[0] ?? '';
      void fetch(`http://127.0.0.1:${port}/callback?${respond(state)}`);
    },
    print: () => undefined,
    readLine: () => Promise.reject(new Error('not pasting')),
  };
}

describe('browserLogin', () => {
  it('signs in with PKCE and returns through the listener on this machine', async () => {
    const sent: { url?: URL } = {};
    const deps = {
      ...browser((state) => `code=the-code&state=${state}`, sent),
      fetch: tokenEndpoint(
        'the-code',
        () => sent.url?.searchParams.get('code_challenge') ?? undefined,
      ),
    };

    const tokens = await browserLogin(LOGIN, { paste: false }, deps);
    expect(tokens).toMatchObject({ accessToken: 'access', refreshToken: 'refresh' });

    const params = Object.fromEntries(sent.url?.searchParams ?? []);
    expect(params).toMatchObject({
      response_type: 'code',
      client_id: 'cli-client',
      redirect_uri: LOGIN.redirectUri,
      code_challenge_method: 'S256',
      scope: 'email',
    });
    expect(params['state']).toMatch(/^\d+\.[A-Za-z0-9_-]{32}$/);
  });

  it('ignores a callback that does not carry its state', async () => {
    const sent: { url?: URL } = {};
    let calls = 0;
    const deps = {
      ...browser(() => '', sent),
      fetch: tokenEndpoint('real', () => sent.url?.searchParams.get('code_challenge') ?? undefined),
    };
    deps.openUrl = (url) => {
      sent.url = new URL(url);
      const state = sent.url.searchParams.get('state') ?? '';
      const port = state.split('.')[0] ?? '';
      void (async () => {
        calls += 1;
        await fetch(`http://127.0.0.1:${port}/callback?code=forged&state=${port}.not-this-one`);
        await fetch(`http://127.0.0.1:${port}/callback?code=real&state=${state}`);
      })();
    };

    expect((await browserLogin(LOGIN, { paste: false }, deps)).accessToken).toBe('access');
    expect(calls).toBe(1);
  });

  it('still finishes when no browser opens, from the printed link', async () => {
    const sent: { url?: URL } = {};
    const opener = browser((state) => `code=the-code&state=${state}`, sent).openUrl;
    const printed: string[] = [];
    const deps = {
      ...browser(() => '', sent),
      // The browser fails to open, but the person follows the printed link.
      openUrl: (url: string) => {
        opener(url);
        throw new Error('spawn xdg-open ENOENT');
      },
      print: (line: string) => {
        printed.push(line);
      },
      fetch: tokenEndpoint(
        'the-code',
        () => sent.url?.searchParams.get('code_challenge') ?? undefined,
      ),
    };

    expect((await browserLogin(LOGIN, { paste: false }, deps)).accessToken).toBe('access');
    expect(printed.join('\n')).toContain('open the link above yourself');
  });

  it('stops waiting when the person declines', async () => {
    const deps = {
      ...browser((state) => `error=access_denied&state=${state}`, {}),
      fetch: tokenEndpoint('unused', () => undefined),
    };
    await expect(browserLogin(LOGIN, { paste: false }, deps)).rejects.toThrow(/access_denied/);
  });

  it('takes a pasted code when there is no browser on this machine', async () => {
    const printed: string[] = [];
    let challenge: string | undefined;
    const deps: BrowserLoginDeps = {
      openUrl: () => {
        throw new Error('must not open a browser');
      },
      print: (line) => {
        printed.push(line);
        const url = /https:\S+/.exec(line)?.[0];
        if (url !== undefined)
          challenge = new URL(url).searchParams.get('code_challenge') ?? undefined;
      },
      readLine: () => Promise.resolve('  pasted-code \n'),
      fetch: tokenEndpoint('pasted-code', () => challenge),
    };

    expect((await browserLogin(LOGIN, { paste: true }, deps)).accessToken).toBe('access');
    const link = printed.join('\n');
    expect(new URL(/https:\S+/.exec(link)?.[0] ?? '').searchParams.get('state')).toMatch(
      /^paste\./,
    );
  });

  it('refuses an authorization server that is not https', async () => {
    const deps: BrowserLoginDeps = {
      openUrl: () => {
        throw new Error('must not open anything');
      },
      print: () => undefined,
      readLine: () => Promise.reject(new Error('unused')),
      fetch: () => Promise.reject(new Error('unused')),
    };
    await expect(
      browserLogin(
        { ...LOGIN, authorizationEndpoint: 'http://evil.example/authorize' },
        { paste: false },
        deps,
      ),
    ).rejects.toThrow(/not https/);
  });
});
