// Signing in to the console for real. A person signs up at Kelay ID with an email on
// KELAY_BUILDER_ALLOWLIST, which makes them a builder; the console sends them there and takes them
// back, trades their Kelay ID session for a `kelay-console` token on its own server, and keeps it in
// an httpOnly cookie. The browser here is a cookie jar that follows redirects by hand.
import { CookieJar } from 'tough-cookie';
import { describe, expect, inject, it } from 'vitest';
import { audienceForApp } from '@kelay/contracts';
import { remoteJwks, verifyKelayToken } from '@kelay/tokens';
import { BUILDER, CONSOLE_APP, PASSWORD, TEAM } from '../scripts/lib/data.ts';
import { NEW_BUILDER_EMAIL } from './global-setup.ts';

const { config, builderId } = inject('stack');
const TOKEN_COOKIE = 'kelay_token';

class Browser {
  readonly jar = new CookieJar();

  /** One request, without following its redirect. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookie = await this.jar.getCookieString(url);
    if (cookie) headers.set('cookie', cookie);
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const setCookie of res.headers.getSetCookie()) await this.jar.setCookie(setCookie, url);
    return res;
  }

  /** Follows redirects as a browser does, and returns the page it lands on with the URLs it went through. */
  async open(url: string, init: RequestInit = {}): Promise<{ res: Response; path: string[] }> {
    const path: string[] = [];
    let res = await this.request(url, init);
    for (let hops = 0; res.status >= 300 && res.status < 400; hops++) {
      if (hops > 8) throw new Error(`too many redirects: ${path.join(' → ')}`);
      url = new URL(res.headers.get('location')!, url).toString();
      path.push(url);
      res = await this.request(url);
    }
    return { res, path };
  }

  postForm(url: string, fields: Record<string, string>) {
    return this.open(url, { method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  }

  async cookie(name: string) {
    return (await this.jar.getCookies(config.consoleUrl)).find((c) => c.key === name);
  }
}

/** A hidden field of a server-rendered form. */
const hidden = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1]?.replaceAll('&amp;', '&') ?? '';
/** Page text without the comments React puts between pieces of text. */
const text = (html: string) => html.replaceAll('<!-- -->', '');
const claimsOf = (token: string) => verifyKelayToken(token, { jwks: remoteJwks(config.jwksUrl), issuer: config.issuer, audience: audienceForApp(CONSOLE_APP), app: CONSOLE_APP });

describe('console sign-in through Kelay ID', () => {
  const browser = new Browser();
  let userId: string;
  let firstToken: string;

  it('sends a visitor to Kelay ID’s login page', async () => {
    const { res, path } = await browser.open(`${config.consoleUrl}/apps`);
    const callback = `${config.consoleUrl}/auth/callback`;
    expect(path).toEqual([`${config.consoleUrl}/auth/signin`, `${config.issuer}/login?${new URLSearchParams({ return_to: callback })}`]);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('Create an account');
    expect(hidden(page, 'return_to')).toBe(callback);
  }, 60_000);

  it('signs a new builder up and comes back with an httpOnly token for the console', async () => {
    const { res, path } = await browser.postForm(`${config.issuer}/login`, {
      intent: 'sign-up',
      name: 'New Builder',
      email: NEW_BUILDER_EMAIL,
      password: PASSWORD,
      return_to: `${config.consoleUrl}/auth/callback`,
    });
    expect(path).toEqual([`${config.consoleUrl}/auth/callback`, `${config.consoleUrl}/`]);
    expect(res.status).toBe(200);

    const cookie = (await browser.cookie(TOKEN_COOKIE))!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    firstToken = cookie.value;
    const claims = await claimsOf(firstToken);
    expect(claims).toMatchObject({ role: 'builder', app: CONSOLE_APP });
    userId = claims.sub;
    expect(claims.org).toBe(userId);
    // The token is good for 15 minutes, and the cookie does not outlive it.
    expect(claims.exp - claims.iat).toBe(15 * 60);
    expect(cookie.maxAge).toBeLessThanOrEqual(15 * 60);
  }, 60_000);

  it('loads the console’s pages with that builder’s empty app list', async () => {
    const apps = await browser.open(`${config.consoleUrl}/apps`);
    expect(apps.path).toEqual([]);
    expect(apps.res.status).toBe(200);
    const page = text(await apps.res.text());
    expect(page).toContain('New Builder’s Apps');
    expect(page).toContain('· 0 apps');
    // Not the seeded builder's apps.
    expect(page).not.toContain('Ticket Board');

    const me = await fetch(`${config.controlApiUrl}/v1/me`, { headers: { authorization: `Bearer ${firstToken}` } });
    expect((await me.json()).me).toMatchObject({ userId, email: NEW_BUILDER_EMAIL, role: 'builder', handle: null });
  }, 60_000);

  it('creates an app from the Home prompt, under a handle taken from the builder’s email', async () => {
    const res = await browser.request(`${config.consoleUrl}/api/builder/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: config.consoleUrl },
      body: JSON.stringify({ prompt: 'Reading list for our book club' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.app).toMatchObject({ handle: 'new-builder', name: 'Reading List For', status: 'draft' });
    expect(body.workspace).toMatchObject({ app: body.app.id, state: 'working' });

    const page = text(await (await browser.open(`${config.consoleUrl}/apps`)).res.text());
    expect(page).toContain('· 1 apps');
    expect(page).toContain('Reading List For');
    // The seeded builder still sees their own apps and not this one.
    const seeded = new Browser();
    const login = await seeded.postForm(`${config.issuer}/login`, { intent: 'sign-in', email: BUILDER.email, password: PASSWORD, return_to: `${config.consoleUrl}/auth/callback` });
    expect(login.res.status).toBe(200);
    expect((await claimsOf((await seeded.cookie(TOKEN_COOKIE))!.value)).sub).toBe(builderId);
    const theirs = text(await (await seeded.open(`${config.consoleUrl}/apps`)).res.text());
    expect(theirs).toContain('Jeongyun Lee’s Apps');
    expect(theirs).toContain('Team Wiki');
    expect(theirs).not.toContain('Reading List For');
  }, 60_000);

  it('gets a new token from the Kelay ID session when the old one is gone or about to expire', async () => {
    // What the browser does when the cookie's Max-Age runs out.
    await browser.jar.setCookie(`${TOKEN_COOKIE}=; Max-Age=0; Path=/`, config.consoleUrl);
    expect(await browser.cookie(TOKEN_COOKIE)).toBeUndefined();
    const res = await browser.request(`${config.consoleUrl}/apps`);
    expect(res.status).toBe(200);
    expect((await claimsOf((await browser.cookie(TOKEN_COOKIE))!.value)).sub).toBe(userId);

    // A fresh token is left alone.
    const again = await browser.request(`${config.consoleUrl}/apps`);
    expect(again.headers.getSetCookie().some((c) => c.startsWith(`${TOKEN_COOKIE}=`))).toBe(false);
  }, 60_000);

  it('signs out of the console and of Kelay ID', async () => {
    const { res, path } = await browser.postForm(`${config.consoleUrl}/auth/signout`, {});
    expect(path).toEqual([`${config.consoleUrl}/signin?signed_out=1`]);
    expect(text(await res.text())).toContain('You are signed out.');
    expect(await browser.cookie(TOKEN_COOKIE)).toBeUndefined();
    // The session is over at Kelay ID, so the cookie the browser still holds opens nothing.
    const token = await browser.request(`${config.issuer}/v1/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: CONSOLE_APP }) });
    expect(token.status).toBe(401);
    const { path: back } = await browser.open(`${config.consoleUrl}/apps`);
    expect(back.at(-1)).toContain(`${config.issuer}/login?`);

    // Another site cannot sign a builder out.
    const forged = await fetch(`${config.consoleUrl}/auth/signout`, { method: 'POST', headers: { origin: 'https://evil.example.com' }, redirect: 'manual' });
    expect(forged.status).toBe(403);
  }, 60_000);

  it('turns away a person who is not a builder, and says who is signed in', async () => {
    const junho = TEAM.find((p) => p.key === 'junho')!;
    const visitor = new Browser();
    const { res, path } = await visitor.postForm(`${config.issuer}/login`, { intent: 'sign-in', email: junho.email, password: PASSWORD, return_to: `${config.consoleUrl}/auth/callback` });
    expect(path).toEqual([`${config.consoleUrl}/auth/callback`, `${config.consoleUrl}/signin?error=not_builder`]);
    expect(text(await res.text())).toContain(`${junho.email} is signed in to Kelay ID, but is not a builder.`);
    expect(await visitor.cookie(TOKEN_COOKIE)).toBeUndefined();
  }, 60_000);

  it('signs the seeded builder in through the dev helper', async () => {
    const dev = new Browser();
    const { res, path } = await dev.open(`${config.devLoginUrl}/`);
    expect(path).toEqual([`${config.consoleUrl}/auth/callback`, `${config.consoleUrl}/`]);
    expect(res.status).toBe(200);
    expect((await claimsOf((await dev.cookie(TOKEN_COOKIE))!.value)).sub).toBe(builderId);
  }, 60_000);
});
