import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import type { CliLogin, Fetch } from './client.js';
import type { OAuthTokens } from './settings.js';
import { requestTokens } from './tokens.js';

/**
 * `concord cloud login` in the browser: OAuth 2.1 authorization code with
 * PKCE, against the authorization server Concord Cloud's `/v1/meta` names.
 *
 * The CLI is registered with one redirect URI, a page on the Concord web app
 * (`/cli/callback`), because the server matches redirect URIs exactly and the
 * port this listens on is whatever is free. `state` tells that page where the
 * code goes: `<port>.<nonce>` hands it to the listener here, `paste.<nonce>`
 * shows it to type in, for a terminal with no browser on its machine.
 *
 * The code is useless without the PKCE verifier, which never leaves this
 * process, so the page may forward or show it.
 */

export interface BrowserLoginDeps {
  readonly fetch: Fetch;
  /** Opens a URL in the person's browser; failure is fine, it is printed too. */
  readonly openUrl: (url: string) => void;
  /** Tells the person what is happening, on stderr. */
  readonly print: (line: string) => void;
  /** Reads one line the person types, for a pasted code. */
  readonly readLine: () => Promise<string>;
}

/** How long to wait for the browser before giving up. */
const WAIT_MS = 5 * 60_000;

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

/** Waits on this machine for the web page to hand over the code. */
function listenForCode(): Promise<{
  readonly port: number;
  readonly code: (state: string) => Promise<string>;
}> {
  return new Promise((resolve, reject) => {
    let settle: ((outcome: { code?: string; error?: string; state: string }) => void) | undefined;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code') ?? undefined;
      const error = url.searchParams.get('error') ?? undefined;
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><title>Concord</title><p>${
            error === undefined
              ? 'Signed in. You can close this tab.'
              : 'Sign-in was not completed.'
          }</p>`,
        );
      settle?.({
        ...(code === undefined ? {} : { code }),
        ...(error === undefined ? {} : { error }),
        state: url.searchParams.get('state') ?? '',
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not listen for the sign-in on this machine.'));
        return;
      }
      resolve({
        port: address.port,
        code: (state) =>
          new Promise<string>((done, fail) => {
            const timer = setTimeout(() => {
              finish();
              fail(
                new Error('Timed out waiting for the browser; run `concord cloud login` again.'),
              );
            }, WAIT_MS);
            const finish = (): void => {
              clearTimeout(timer);
              settle = undefined;
              server.closeAllConnections();
              server.close();
            };
            settle = (outcome) => {
              // Anything not carrying this login's state is someone else's.
              if (outcome.state !== state) return;
              finish();
              if (outcome.code !== undefined) done(outcome.code);
              else fail(new Error(`Sign-in was not completed (${outcome.error ?? 'no code'}).`));
            };
          }),
      });
    });
  });
}

export async function browserLogin(
  login: CliLogin,
  options: { readonly paste: boolean },
  deps: BrowserLoginDeps,
): Promise<OAuthTokens> {
  const verifier = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(24));
  const listener = options.paste ? undefined : await listenForCode();
  const state = `${listener === undefined ? 'paste' : String(listener.port)}.${nonce}`;

  const authorize = new URL(login.authorizationEndpoint);
  for (const [name, value] of Object.entries({
    response_type: 'code',
    client_id: login.clientId,
    redirect_uri: login.redirectUri,
    code_challenge: base64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    state,
    scope: 'email',
  })) {
    authorize.searchParams.set(name, value);
  }

  deps.print(`Sign in to Concord Cloud in your browser:\n  ${authorize.toString()}`);
  let code: string;
  if (listener === undefined) {
    deps.print('Then paste the code the page shows:');
    code = (await deps.readLine()).trim();
    if (code === '') throw new Error('No code was entered.');
  } else {
    deps.openUrl(authorize.toString());
    code = await listener.code(state);
  }

  return requestTokens(
    { clientId: login.clientId, tokenEndpoint: login.tokenEndpoint },
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: login.redirectUri,
      code_verifier: verifier,
    },
    deps.fetch,
  );
}
