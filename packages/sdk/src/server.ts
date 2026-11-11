// Helpers for an app's server side (its Lambda web handler and agent nodes).
import { USER_AUTHORIZATION_HEADER } from '@kelay/contracts';
import { KelayError } from './errors.ts';

export { USER_AUTHORIZATION_HEADER };

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

const BEARER = /^Bearer[ \t]+(\S+)$/i;

function header(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The signed-in user's Kelay ID token from an incoming request, or null when there is none.
 * Behind the router the token arrives in `x-kelay-authorization`, because SigV4 occupies
 * `authorization` on requests to a function URL (contract §4); that header wins when both are present.
 */
export function userTokenFromHeaders(headers: HeaderBag): string | null {
  for (const name of [USER_AUTHORIZATION_HEADER, 'authorization']) {
    const token = BEARER.exec(header(headers, name) ?? '')?.[1];
    if (token) return token;
  }
  return null;
}

/** Like `userTokenFromHeaders`, but throws `unauthenticated` when the request carries no user token. */
export function requireUserToken(headers: HeaderBag): string {
  const token = userTokenFromHeaders(headers);
  if (!token) throw new KelayError('unauthenticated', 'the request carries no Kelay ID token');
  return token;
}
