import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audienceForApp } from '@kelay/contracts';
import { remoteJwks, verifyKelayToken } from '@kelay/tokens';
import { mayBecomeBuilder, socialFromEnv } from './index.ts';
import { Browser, ISSUER, PASSWORD, startTestIdentity, type TestIdentity } from './test-support.ts';

const CONSOLE_ORIGIN = 'https://console.kelay.test';

let t: TestIdentity;
let server: ServerType;
let jwksUrl: string;
const enrollments: string[] = [];
let controlApiDown = false;

beforeAll(async () => {
  t = await startTestIdentity({
    social: { google: { clientId: 'google-test-id', clientSecret: 'google-test-secret' } },
    corsOrigins: [CONSOLE_ORIGIN],
    clientIpHeader: 'CF-Connecting-IP',
    builders: {
      allowlist: ['First.Builder@example.com'],
      open: false,
      requireVerifiedEmail: false,
      // What the control API's member route does for kelay-console.
      enroll: async (userId) => {
        enrollments.push(userId);
        if (controlApiDown) throw new Error('control API answered 503');
        await t.setMember({ app: 'kelay-console', user_id: userId, org: userId, role: 'builder', plan: 'free', status: 'active' });
      },
    },
  });
  server = serve({ fetch: t.identity.app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  jwksUrl = `http://localhost:${(server.address() as AddressInfo).port}/api/auth/jwks`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await t.close();
});

describe('service', () => {
  it('reports health', async () => {
    const res = await t.identity.app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('serves an Ed25519 JWKS at /api/auth/jwks', async () => {
    const res = await t.identity.app.request('/api/auth/jwks');
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: Record<string, string>[] };
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });
    expect(keys[0]).not.toHaveProperty('d');
  });

  it('serves OAuth authorization server metadata with CIMD on and DCR off', async () => {
    const res = await t.identity.app.request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const md = (await res.json()) as Record<string, unknown>;
    expect(md).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/api/auth/oauth2/authorize`,
      token_endpoint: `${ISSUER}/api/auth/oauth2/token`,
      jwks_uri: `${ISSUER}/api/auth/jwks`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['offline_access'],
    });
    expect(md.registration_endpoint).toBeUndefined();
    expect(md.grant_types_supported).not.toContain('client_credentials');
  });

  it('reads the client IP for rate limits from the configured header', () => {
    expect(t.identity.auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual(['cf-connecting-ip']);
  });

  it('turns off the session-JWT route and dynamic client registration', async () => {
    const browser = new Browser(t.identity.app);
    await browser.signUp('jwt-route@example.com');
    expect((await browser.get('/api/auth/token')).status).toBe(404);
    const register = await browser.postJson('/api/auth/oauth2/register', { redirect_uris: ['https://evil.example.com/cb'] });
    expect(register.ok).toBe(false);
  });
});

describe('email and password', () => {
  it('signs up, then signs in from a fresh browser', async () => {
    const id = await new Browser(t.identity.app).signUp('ada@example.com', 'Ada');
    const browser = new Browser(t.identity.app);
    const res = await browser.postJson('/api/auth/sign-in/email', { email: 'ada@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    const session = (await (await browser.get('/api/auth/get-session')).json()) as { user: { id: string; email: string } };
    expect(session.user).toMatchObject({ id, email: 'ada@example.com' });
  });

  it('rejects a wrong password', async () => {
    await new Browser(t.identity.app).signUp('bob@example.com');
    const res = await new Browser(t.identity.app).postJson('/api/auth/sign-in/email', {
      email: 'bob@example.com',
      password: 'not the password',
    });
    expect(res.status).toBe(401);
  });

  it('signs in through the login form and lands on the account page', async () => {
    await new Browser(t.identity.app).signUp('cy@example.com');
    const browser = new Browser(t.identity.app);
    const login = await browser.get('/login');
    expect(login.status).toBe(200);
    const page = await login.text();
    expect(page).toContain('<label for="sign-in-email">Email</label>');
    const res = await browser.postForm('/login', { intent: 'sign-in', email: 'cy@example.com', password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(await (await browser.get('/')).text()).toContain('Signed in as cy@example.com');
  });

  it('returns to the page that sent the person to sign in, when its origin is allowed', async () => {
    const back = `${CONSOLE_ORIGIN}/auth/callback`;
    await new Browser(t.identity.app).signUp('dee@example.com');
    const browser = new Browser(t.identity.app);
    const form = await (await browser.get(`/login?return_to=${encodeURIComponent(back)}`)).text();
    expect(form).toContain(`name="return_to" value="${back}"`);
    const res = await browser.postForm('/login', { intent: 'sign-in', email: 'dee@example.com', password: PASSWORD, return_to: back });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(back);
    // With a session there is nothing to fill in.
    const again = await browser.get(`/login?return_to=${encodeURIComponent(back)}`);
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe(back);

    // Any other origin is dropped, and so is a loopback one unless the instance allows it.
    for (const other of ['https://evil.example.com/', 'http://localhost:55123/', 'javascript:alert(1)', '//evil.example.com']) {
      const refused = await browser.get(`/login?return_to=${encodeURIComponent(other)}`);
      expect(refused.status, other).toBe(200);
      expect(await refused.text()).toContain('name="return_to" value=""');
      const posted = await new Browser(t.identity.app).postForm('/login', { intent: 'sign-in', email: 'dee@example.com', password: PASSWORD, return_to: other });
      expect(posted.headers.get('location'), other).toBe('/');
    }
  });

  it('shows the error on the login form for bad credentials', async () => {
    const res = await new Browser(t.identity.app).postForm('/login', {
      intent: 'sign-in',
      email: 'nobody@example.com',
      password: 'whatever-password',
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('role="alert"');
  });
});

describe('social providers', () => {
  it('enables a provider only when both its client id and secret are set', () => {
    expect(
      socialFromEnv({ GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's', KAKAO_CLIENT_ID: 'k', GITHUB_CLIENT_SECRET: 'x' }),
    ).toEqual({ google: { clientId: 'g', clientSecret: 's' } });
  });

  it('offers configured providers on the login page and starts their redirect', async () => {
    const browser = new Browser(t.identity.app);
    const page = await (await browser.get('/login')).text();
    expect(page).toContain('Continue with Google');
    expect(page).not.toContain('Continue with Kakao');
    const google = await browser.postForm('/login/social', { provider: 'google' });
    expect(google.status).toBe(303);
    expect(new URL(google.headers.get('location')!).host).toBe('accounts.google.com');
    expect((await browser.postForm('/login/social', { provider: 'kakao' })).status).toBe(400);
    // A sign-in that has somewhere to return to still comes back through Kelay ID's own login page.
    const withReturn = await browser.postForm('/login/social', { provider: 'google', return_to: `${CONSOLE_ORIGIN}/auth/callback` });
    expect(withReturn.status).toBe(303);
  });
});

describe('first-builder bootstrap', () => {
  it('makes an allowlisted sign-up a builder, and nobody else', async () => {
    const builder = new Browser(t.identity.app);
    const builderId = await builder.signUp('first.builder@example.com');
    expect(enrollments).toEqual([builderId]);
    const res = await builder.postJson('/v1/token', { app: 'kelay-console' });
    expect(res.status).toBe(200);
    const claims = await verifyKelayToken(((await res.json()) as { token: string }).token, { jwks: remoteJwks(jwksUrl), issuer: ISSUER, audience: audienceForApp('kelay-console'), app: 'kelay-console' });
    expect(claims).toMatchObject({ sub: builderId, org: builderId, role: 'builder' });

    const other = new Browser(t.identity.app);
    await other.signUp('someone.else@example.com');
    expect(enrollments).toEqual([builderId]);
    expect((await other.postJson('/v1/token', { app: 'kelay-console' })).status).toBe(403);
    // The bootstrap is for the console only.
    expect((await builder.postJson('/v1/token', { app: 'ticket-board' })).status).toBe(403);
  });

  it('enrolls at the first console token when the control API missed the sign-up', async () => {
    await t.pool.query(`delete from "user" where email = 'first.builder@example.com'`);
    await t.pool.query(`delete from app_members where app = 'kelay-console'`);
    controlApiDown = true;
    const builder = new Browser(t.identity.app);
    const builderId = await builder.signUp('first.builder@example.com');
    expect((await builder.postJson('/v1/token', { app: 'kelay-console' })).status).toBe(403);
    controlApiDown = false;
    expect((await builder.postJson('/v1/token', { app: 'kelay-console' })).status).toBe(200);
    // A builder the console banned is not enrolled again.
    await t.setMember({ app: 'kelay-console', user_id: builderId, org: builderId, role: 'builder', plan: 'free', status: 'banned' });
    const before = enrollments.length;
    expect((await builder.postJson('/v1/token', { app: 'kelay-console' })).status).toBe(403);
    expect(enrollments).toHaveLength(before);
  });

  it('decides by the allowlist, open sign-up and whether the email is verified', () => {
    const rules = { allowlist: ['a@example.com'], open: false, requireVerifiedEmail: true, enroll: async () => {} };
    expect(mayBecomeBuilder(rules, { email: 'A@Example.com', emailVerified: true })).toBe(true);
    expect(mayBecomeBuilder(rules, { email: 'a@example.com', emailVerified: false })).toBe(false);
    expect(mayBecomeBuilder({ ...rules, requireVerifiedEmail: false }, { email: 'a@example.com', emailVerified: false })).toBe(true);
    expect(mayBecomeBuilder(rules, { email: 'b@example.com', emailVerified: true })).toBe(false);
    expect(mayBecomeBuilder({ ...rules, open: true }, { email: 'b@example.com', emailVerified: false })).toBe(true);
  });
});

describe('POST /v1/token', () => {
  it('requires a session', async () => {
    const res = await t.identity.app.request('/v1/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'ticket-board' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('returns a token for a member that verifyKelayToken accepts against the served JWKS', async () => {
    const browser = new Browser(t.identity.app);
    const userId = await browser.signUp('member@example.com');
    await t.setMember({ app: 'ticket-board', user_id: userId, org: 'orum', role: 'agent', plan: 'pro', status: 'active' });
    const res = await browser.postJson('/v1/token', { app: 'ticket-board' });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const claims = await verifyKelayToken(token, {
      jwks: remoteJwks(jwksUrl),
      issuer: ISSUER,
      audience: audienceForApp('ticket-board'),
      app: 'ticket-board',
    });
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: userId,
      aud: 'kelay:app:ticket-board',
      app: 'ticket-board',
      org: 'orum',
      role: 'agent',
      plan: 'pro',
    });
    expect(claims.exp - claims.iat).toBe(15 * 60);
    expect(claims.azp).toBeUndefined();
  });

  it('refuses non-members, unconfirmed members and banned members', async () => {
    const browser = new Browser(t.identity.app);
    const userId = await browser.signUp('outsider@example.com');
    const nonMember = await browser.postJson('/v1/token', { app: 'ticket-board' });
    expect(nonMember.status).toBe(403);
    expect(await nonMember.json()).toMatchObject({ error: { code: 'denied' } });

    for (const status of ['unconfirmed', 'banned'] as const) {
      await t.setMember({ app: 'ticket-board', user_id: userId, org: 'orum', role: 'agent', plan: 'free', status });
      const refused = await browser.postJson('/v1/token', { app: 'ticket-board' });
      expect(refused.status, status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: 'denied' } });
    }
    await t.setMember({ app: 'ticket-board', user_id: userId, org: 'orum', role: 'agent', plan: 'free', status: 'active' });
    expect((await browser.postJson('/v1/token', { app: 'ticket-board' })).status).toBe(200);
  });

  it('answers cross-origin calls from configured origins only', async () => {
    const browser = new Browser(t.identity.app);
    const userId = await browser.signUp('cors@example.com');
    await t.setMember({ app: 'ticket-board', user_id: userId, org: 'orum', role: 'agent', plan: 'free', status: 'active' });
    const preflight = (origin: string) =>
      t.identity.app.request('/v1/token', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });
    const post = (origin: string) =>
      browser.request('/v1/token', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ app: 'ticket-board' }) });

    const allowed = await preflight(CONSOLE_ORIGIN);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(CONSOLE_ORIGIN);
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    expect(allowed.headers.get('access-control-allow-methods')).toBe('POST');
    const fromConsole = await post(CONSOLE_ORIGIN);
    expect(fromConsole.status).toBe(200);
    expect(fromConsole.headers.get('access-control-allow-origin')).toBe(CONSOLE_ORIGIN);
    expect(fromConsole.headers.get('vary')).toContain('Origin');

    const other = 'https://evil.example.com';
    expect((await preflight(other)).headers.get('access-control-allow-origin')).toBeNull();
    const fromOther = await post(other);
    expect(fromOther.status).toBe(403);
    expect(fromOther.headers.get('access-control-allow-origin')).toBeNull();
    expect(await fromOther.json()).toMatchObject({ error: { code: 'denied' } });
  });

  it('rejects a body without a valid app slug', async () => {
    const browser = new Browser(t.identity.app);
    await browser.signUp('bad-body@example.com');
    for (const body of [{}, { app: 'Not A Slug' }]) {
      const res = await browser.postJson('/v1/token', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    }
  });
});
