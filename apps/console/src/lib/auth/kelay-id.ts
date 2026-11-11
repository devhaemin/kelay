// The console's sign-in. A builder signs in at Kelay ID, whose session cookie the browser also sends
// to the console: the two share a site (`localhost` locally, one parent domain when deployed). The
// console's server trades that session for a `kelay-console` token (contracts §8) and keeps the
// token in an httpOnly cookie. Kelay ID signs tokens for 15 minutes, so the proxy (src/proxy.ts)
// trades again shortly before one expires. Used by the proxy and by route handlers: server code only.
import { createAuthClient } from 'better-auth/client';

/** The builder's `kelay-console` token. httpOnly: it never reaches browser JavaScript. */
export const TOKEN_COOKIE = 'kelay_token';
export const CONSOLE_APP = 'kelay-console';
/** A token this close to its expiry is replaced on the next request. */
export const REFRESH_BEFORE_MS = 3 * 60_000;

const trimSlash = (url: string) => url.replace(/\/+$/, '');
export const kelayIdUrl = (): string => trimSlash(process.env.KELAY_ID_ISSUER ?? 'http://localhost:4001');
/** The console's own public origin, which Kelay ID must list in KELAY_ID_CORS_ORIGINS. */
export const consoleUrl = (): string => trimSlash(process.env.CONSOLE_URL ?? 'http://localhost:3000');

/** Kelay ID's login page, returning to the console's callback once the person is signed in. */
export const loginUrl = (): string => `${kelayIdUrl()}/login?${new URLSearchParams({ return_to: `${consoleUrl()}/auth/callback` })}`;

const authClient = () => createAuthClient({ baseURL: kelayIdUrl() });

export type Exchange =
  | { ok: true; token: string; expiresAt: number }
  /** `signed_out`: no Kelay ID session. `not_builder`: a session, but its person is not a builder. */
  | { ok: false; reason: 'signed_out' | 'not_builder' | 'unavailable' };

/** When the token expires, in epoch milliseconds; 0 for anything that is not a token. Not a verification: the Control API does that. */
export function tokenExpiry(token: string | undefined): number {
  try {
    const payload = JSON.parse(Buffer.from(token?.split('.')[1] ?? '', 'base64url').toString()) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export const needsRefresh = (token: string | undefined, now = Date.now()): boolean => tokenExpiry(token) - now < REFRESH_BEFORE_MS;

/** Trades the Kelay ID session in the browser's cookies for a `kelay-console` token (`POST /v1/token`). */
export async function exchangeSession(cookie: string | null): Promise<Exchange> {
  if (!cookie) return { ok: false, reason: 'signed_out' };
  let res: Response;
  try {
    res = await fetch(`${kelayIdUrl()}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', cookie },
      body: JSON.stringify({ app: CONSOLE_APP }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (res.status === 401) return { ok: false, reason: 'signed_out' };
  if (res.status === 403) return { ok: false, reason: 'not_builder' };
  const token = res.ok ? ((await res.json().catch(() => null)) as { token?: unknown } | null)?.token : undefined;
  if (typeof token !== 'string' || tokenExpiry(token) <= Date.now()) return { ok: false, reason: 'unavailable' };
  return { ok: true, token, expiresAt: tokenExpiry(token) };
}

export function tokenCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
  };
}

/** The email of the person signed in at Kelay ID, or null. */
export async function signedInEmail(cookie: string | null): Promise<string | null> {
  if (!cookie) return null;
  const { data } = await authClient()
    .getSession({ fetchOptions: { headers: { cookie }, cache: 'no-store' } })
    .catch(() => ({ data: null }));
  return data?.user.email ?? null;
}

/** Ends the Kelay ID session, so the cookie the browser still holds opens nothing. */
export async function endSession(cookie: string | null): Promise<void> {
  if (!cookie) return;
  // better-auth takes a POST that carries cookies only from an origin it trusts; the console's is one.
  await authClient()
    .signOut({ fetchOptions: { headers: { cookie, origin: consoleUrl() }, cache: 'no-store' } })
    .catch(() => undefined);
}
