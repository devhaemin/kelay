import { CALLER_HEADER } from '@kelay/contracts';
import { KelayError, errorFromResponse } from './errors.ts';

export type TokenGetter = () => string | Promise<string>;

export interface AuthOptions {
  /** Kelay ID user token, sent as `authorization: Bearer …`. */
  getUserToken: TokenGetter;
  /** Caller token for this app runtime, sent as `x-kelay-caller`. */
  getCallerToken: TokenGetter;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

/** POSTs JSON with Kelay auth headers. Every failure, including token getters and the network, becomes a KelayError. */
export async function postJson(url: string, body: unknown, auth: AuthOptions): Promise<unknown> {
  let userToken: string;
  let callerToken: string;
  try {
    [userToken, callerToken] = await Promise.all([auth.getUserToken(), auth.getCallerToken()]);
  } catch (e) {
    throw new KelayError('unauthenticated', `could not get a token: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }

  const doFetch = auth.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${userToken}`,
        [CALLER_HEADER]: callerToken,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new KelayError('network', `request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }

  const text = await res.text().catch(() => '');
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (res.ok) throw new KelayError('internal', `invalid JSON from ${url}`, { status: res.status });
    }
  }
  if (!res.ok) throw errorFromResponse(res.status, json);
  return json;
}
