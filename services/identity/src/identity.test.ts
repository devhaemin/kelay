import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audienceForApp } from '@kelay/contracts';
import { remoteJwks, verifyKelayToken } from '@kelay/tokens';
import { socialFromEnv } from './index.ts';
import { Browser, ISSUER, PASSWORD, startTestIdentity, type TestIdentity } from './test-support.ts';

let t: TestIdentity;
let server: ServerType;
let jwksUrl: string;

beforeAll(async () => {
  t = await startTestIdentity({ social: { google: { clientId: 'google-test-id', clientSecret: 'google-test-secret' } } });
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

  it('refuses non-members and banned members', async () => {
    const browser = new Browser(t.identity.app);
    const userId = await browser.signUp('outsider@example.com');
    const nonMember = await browser.postJson('/v1/token', { app: 'ticket-board' });
    expect(nonMember.status).toBe(403);
    expect(await nonMember.json()).toMatchObject({ error: { code: 'denied' } });

    await t.setMember({ app: 'ticket-board', user_id: userId, org: 'orum', role: 'agent', plan: 'free', status: 'banned' });
    const banned = await browser.postJson('/v1/token', { app: 'ticket-board' });
    expect(banned.status).toBe(403);
    expect(await banned.json()).toMatchObject({ error: { code: 'denied' } });
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
