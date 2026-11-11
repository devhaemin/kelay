// A signed-in Kelay ID browser session without the browser: keeps cookies and never follows redirects.
// `fetch` is injectable, so the seed can drive an in-process Kelay ID and the e2e suite a running one.
import { CookieJar } from 'tough-cookie';

export type Fetch = (url: string, init?: RequestInit) => Response | Promise<Response>;

export class KelayIdSession {
  readonly jar = new CookieJar();

  constructor(
    private readonly issuer: string,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.issuer).toString();
    const headers = new Headers(init.headers);
    const cookie = await this.jar.getCookieString(url);
    if (cookie) headers.set('cookie', cookie);
    const res = await this.fetchImpl(url, { ...init, headers, redirect: 'manual' });
    for (const setCookie of res.headers.getSetCookie()) await this.jar.setCookie(setCookie, url);
    return res;
  }

  get(path: string): Promise<Response> {
    return this.request(path);
  }

  // better-auth checks the Origin of state-changing requests against its own origin.
  postJson(path: string, body: unknown): Promise<Response> {
    return this.request(path, {
      method: 'POST',
      headers: { origin: this.issuer, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  postForm(path: string, fields: Record<string, string>): Promise<Response> {
    return this.request(path, {
      method: 'POST',
      headers: { origin: this.issuer, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  }

  async signIn(email: string, password: string): Promise<string> {
    const res = await this.postJson('/api/auth/sign-in/email', { email, password });
    if (!res.ok) throw new Error(`sign-in as ${email} failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { user: { id: string } }).user.id;
  }

  /** Signs up, or signs in when the account already exists. Returns the user id. */
  async signUpOrIn(name: string, email: string, password: string): Promise<string> {
    const res = await this.postJson('/api/auth/sign-up/email', { name, email, password });
    if (res.ok) return ((await res.json()) as { user: { id: string } }).user.id;
    const body = await res.text();
    if (res.status === 422 && body.includes('USER_ALREADY_EXISTS')) return this.signIn(email, password);
    throw new Error(`sign-up as ${email} failed: ${res.status} ${body}`);
  }

  /** `POST /v1/token { app }` (contract §8): an app-scoped token for the signed-in person. */
  async appToken(app: string): Promise<string> {
    const res = await this.postJson('/v1/token', { app });
    if (!res.ok) throw new Error(`token for ${app} failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { token: string }).token;
  }
}
