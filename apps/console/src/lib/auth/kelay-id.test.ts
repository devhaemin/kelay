import { afterEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_BEFORE_MS, exchangeSession, loginUrl, needsRefresh, tokenCookieOptions, tokenExpiry } from './kelay-id';

const NOW = Date.parse('2026-11-12T09:00:00Z');
/** Shaped like a Kelay ID token; the console reads only `exp` and leaves verifying to the Control API. */
const token = (expiresInMs: number) => `h.${Buffer.from(JSON.stringify({ sub: 'u1', exp: Math.floor((NOW + expiresInMs) / 1000) })).toString('base64url')}.s`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the builder token', () => {
  it('is replaced three minutes before it expires, and when it is missing or not a token', () => {
    expect(needsRefresh(token(15 * 60_000), NOW)).toBe(false);
    expect(needsRefresh(token(REFRESH_BEFORE_MS + 5_000), NOW)).toBe(false);
    expect(needsRefresh(token(REFRESH_BEFORE_MS - 5_000), NOW)).toBe(true);
    expect(needsRefresh(token(-60_000), NOW)).toBe(true);
    expect(needsRefresh(undefined, NOW)).toBe(true);
    expect(needsRefresh('pasted-by-hand', NOW)).toBe(true);
    expect(tokenExpiry('a.b.c')).toBe(0);
  });

  it('lives in a cookie that ends when the token does', () => {
    vi.useFakeTimers({ now: NOW });
    expect(tokenCookieOptions(NOW + 15 * 60_000)).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 900 });
  });
});

describe('trading the Kelay ID session for the token', () => {
  const kelayId = (status: number, body: unknown) => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json(body, { status }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('forwards the browser’s cookies to POST /v1/token for kelay-console', async () => {
    vi.useFakeTimers({ now: NOW });
    const fetch = kelayId(200, { token: token(15 * 60_000) });
    expect(await exchangeSession('better-auth.session_token=abc')).toEqual({ ok: true, token: token(15 * 60_000), expiresAt: NOW + 15 * 60_000 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:4001/v1/token');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ app: 'kelay-console' }) });
    expect(new Headers(init.headers).get('cookie')).toBe('better-auth.session_token=abc');
  });

  it('tells signed out from not a builder from Kelay ID being away', async () => {
    kelayId(401, { error: { code: 'unauthenticated' } });
    expect(await exchangeSession('c=1')).toEqual({ ok: false, reason: 'signed_out' });
    kelayId(403, { error: { code: 'denied' } });
    expect(await exchangeSession('c=1')).toEqual({ ok: false, reason: 'not_builder' });
    kelayId(500, {});
    expect(await exchangeSession('c=1')).toEqual({ ok: false, reason: 'unavailable' });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('connect ECONNREFUSED'))));
    expect(await exchangeSession('c=1')).toEqual({ ok: false, reason: 'unavailable' });
    // No cookies at all: nothing to ask Kelay ID about.
    const fetch = kelayId(200, {});
    expect(await exchangeSession(null)).toEqual({ ok: false, reason: 'signed_out' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends a sign-in to Kelay ID’s login page and back to the callback', () => {
    expect(loginUrl()).toBe('http://localhost:4001/login?return_to=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback');
  });
});
