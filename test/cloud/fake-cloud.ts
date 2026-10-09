import { z } from 'zod';

type JsonValue = z.infer<ReturnType<typeof z.json>>;

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: JsonValue;
}

export interface Reply {
  readonly status: number;
  readonly json: object;
}
export type Route = readonly [string, () => Reply];
export const ok = (json: object): Reply => ({ status: 200, json });

/** A Concord Cloud that answers from `routes` ("METHOD /path"), recording every request. */
export function fakeCloud(routes: readonly Route[]) {
  const table = new Map(routes);
  const requests: Recorded[] = [];
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const path = new URL(input).pathname;
    const body = typeof init?.body === 'string' ? z.json().parse(JSON.parse(init.body)) : null;
    requests.push({ method, path, body });
    const route = table.get(`${method} ${path}`);
    const { status, json } =
      route === undefined ? { status: 404, json: { error: 'no route' } } : route();
    return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(json), { status }));
  };
  return { fetch, requests };
}
