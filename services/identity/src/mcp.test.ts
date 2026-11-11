// MCP authorization (MCP 2026-07-28): authorization code + PKCE with a CIMD client, one resource per app.
import * as oauth from 'oauth4webapi';
import type { JSONWebKeySet } from 'jose';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localJwks, verifyKelayToken } from '@kelay/tokens';
import { mcpResourceUrl } from './index.ts';
import { Browser, ISSUER, MCP_BASE, PASSWORD, startTestIdentity, type TestIdentity } from './test-support.ts';

const CLIENT_ID = 'https://assistant.example.com/oauth/client.json';
const REDIRECT_URI = 'http://127.0.0.1:33418/callback';
const client: oauth.Client = { client_id: CLIENT_ID, token_endpoint_auth_method: 'none' };
const RESOURCE = {
  board: mcpResourceUrl(MCP_BASE, 'orum', 'ticket-board'),
  wiki: mcpResourceUrl(MCP_BASE, 'orum', 'wiki'),
  notes: mcpResourceUrl(MCP_BASE, 'acme', 'notes'),
};
const EMAIL = 'ada@example.com';

const metadataFetches: string[] = [];
const fetchClientMetadataResource: ClientMetadataResourceFetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  metadataFetches.push(url);
  if (url !== CLIENT_ID) return new Response('not found', { status: 404 });
  return Response.json(
    {
      client_id: CLIENT_ID,
      client_name: 'Test Assistant',
      client_uri: 'https://assistant.example.com',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    { headers: { 'cache-control': 'max-age=300' } },
  );
};

let t: TestIdentity;
let browser: Browser;
let as: oauth.AuthorizationServer;
let jwks: ReturnType<typeof localJwks>;
let userId: string;

const http = () => ({
  [oauth.customFetch]: async (url: string, init: oauth.CustomFetchOptions<string, unknown>) =>
    t.identity.app.request(url, init as RequestInit),
  [oauth.allowInsecureRequests]: true,
});

interface Authorization {
  url: string;
  verifier: string;
  state: string;
  resource: string | undefined;
}

async function authorization(...resources: string[]): Promise<Authorization> {
  const verifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const url = new URL(as.authorization_endpoint!);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'offline_access',
    state,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  for (const r of resources) params.append('resource', r);
  url.search = params.toString();
  return { url: url.toString(), verifier, state, resource: resources[0] };
}

function redirectTarget(res: Response): URL {
  expect([302, 303]).toContain(res.status);
  return new URL(res.headers.get('location')!, ISSUER);
}

const signedQuery = (url: URL) => url.search.slice(1);

async function exchange(auth: Authorization, callback: URL) {
  const params = oauth.validateAuthResponse(as, client, callback, auth.state);
  const res = await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), params, REDIRECT_URI, auth.verifier, {
    ...http(),
    ...(auth.resource ? { additionalParameters: { resource: auth.resource } } : {}),
  });
  return oauth.processAuthorizationCodeResponse(as, client, res);
}

/** Starts an authorization for `resource` with an existing session, accepts consent, returns the callback. */
async function consentTo(auth: Authorization): Promise<{ page: string; callback: URL }> {
  const consent = redirectTarget(await browser.get(auth.url));
  expect(consent.pathname).toBe('/consent');
  const page = await (await browser.get(consent.toString())).text();
  const callback = redirectTarget(await browser.postForm('/consent', { oauth_query: signedQuery(consent), accept: 'yes' }));
  return { page, callback };
}

const verify = (token: string, resource: string, app: string) =>
  verifyKelayToken(token, { jwks, issuer: ISSUER, audience: resource, app });

beforeAll(async () => {
  t = await startTestIdentity({ fetchClientMetadataResource });
  as = await oauth.processDiscoveryResponse(new URL(ISSUER), await oauth.discoveryRequest(new URL(ISSUER), { algorithm: 'oauth2', ...http() }));
  jwks = localJwks((await (await t.identity.app.request('/api/auth/jwks')).json()) as JSONWebKeySet);
  userId = await new Browser(t.identity.app).signUp(EMAIL, 'Ada');
  await t.setMember({ app: 'ticket-board', user_id: userId, org: 'orum', role: 'agent', plan: 'pro', status: 'active' });
  await t.setMember({ app: 'wiki', user_id: userId, org: 'orum', role: 'editor', plan: 'free', status: 'active' });
  browser = new Browser(t.identity.app);
});

afterAll(async () => {
  await t.close();
});

describe('MCP authorization with a Client ID Metadata Document client', () => {
  const tokens: Record<string, oauth.TokenEndpointResponse> = {};

  it('signs in, asks for consent naming the client and the app, and binds the token to that app', async () => {
    const auth = await authorization(RESOURCE.board);
    const login = redirectTarget(await browser.get(auth.url));
    expect(`${login.origin}${login.pathname}`).toBe(`${ISSUER}/login`);
    expect(metadataFetches).toContain(CLIENT_ID);
    expect(await (await browser.get(login.toString())).text()).toContain('name="oauth_query"');

    const consent = redirectTarget(
      await browser.postForm('/login', { intent: 'sign-in', email: EMAIL, password: PASSWORD, oauth_query: signedQuery(login) }),
    );
    expect(consent.pathname).toBe('/consent');
    const page = await (await browser.get(consent.toString())).text();
    expect(page).toContain('<strong>Test Assistant</strong> wants to use <strong>orum/ticket-board</strong> as you.');
    expect(page).toContain(CLIENT_ID);
    expect(page).toContain('agent, pro plan');
    expect(page).toContain('value="yes"');

    const callback = redirectTarget(await browser.postForm('/consent', { oauth_query: signedQuery(consent), accept: 'yes' }));
    expect(callback.toString().startsWith(REDIRECT_URI)).toBe(true);
    const res = await exchange(auth, callback);
    expect(res.token_type).toBe('bearer');
    expect(res.scope).toBe('offline_access');
    expect(res.refresh_token).toBeTruthy();
    tokens.board = res;

    expect(await verify(res.access_token, RESOURCE.board, 'ticket-board')).toMatchObject({
      iss: ISSUER,
      sub: userId,
      aud: RESOURCE.board,
      azp: CLIENT_ID,
      app: 'ticket-board',
      org: 'orum',
      role: 'agent',
      plan: 'pro',
    });
    await expect(verify(res.access_token, RESOURCE.wiki, 'wiki')).rejects.toThrow(/aud/);
    await expect(verify(res.access_token, 'kelay:app:ticket-board', 'ticket-board')).rejects.toThrow(/aud/);
  });

  it('asks again for another app, and keeps the first app consented', async () => {
    const wiki = await authorization(RESOURCE.wiki);
    const { page, callback } = await consentTo(wiki);
    expect(page).toContain('<strong>orum/wiki</strong>');
    expect(page).toContain('editor, free plan');
    tokens.wiki = await exchange(wiki, callback);
    expect(await verify(tokens.wiki.access_token, RESOURCE.wiki, 'wiki')).toMatchObject({ app: 'wiki', role: 'editor', plan: 'free' });

    const board = await authorization(RESOURCE.board);
    const direct = redirectTarget(await browser.get(board.url));
    expect(direct.toString().startsWith(REDIRECT_URI)).toBe(true);
    expect(await verify((await exchange(board, direct)).access_token, RESOURCE.board, 'ticket-board')).toMatchObject({ role: 'agent' });

    const consents = (await (await browser.get('/api/auth/oauth2/get-consents')).json()) as {
      referenceId: string;
      resources: string[];
    }[];
    expect(consents.map((c) => [c.referenceId, c.resources]).sort()).toEqual([
      ['ticket-board', [RESOURCE.board]],
      ['wiki', [RESOURCE.wiki]],
    ]);
  });

  it('refreshes while membership and consent hold; a ban or a revoked consent ends access', async () => {
    const refresh = (token: string) => oauth.refreshTokenGrantRequest(as, client, oauth.None(), token, http());

    const refreshed = await oauth.processRefreshTokenResponse(as, client, await refresh(tokens.board!.refresh_token!));
    expect(await verify(refreshed.access_token, RESOURCE.board, 'ticket-board')).toMatchObject({ role: 'agent', azp: CLIENT_ID });

    await t.setMember({ app: 'ticket-board', user_id: userId, org: 'orum', role: 'agent', plan: 'pro', status: 'banned' });
    const afterBan = await refresh(refreshed.refresh_token!);
    expect(afterBan.status).toBe(400);
    expect(await afterBan.json()).toMatchObject({ error: 'invalid_grant' });

    const consents = (await (await browser.get('/api/auth/oauth2/get-consents')).json()) as { id: string; referenceId: string }[];
    const wikiConsent = consents.find((c) => c.referenceId === 'wiki')!;
    expect((await browser.postJson('/api/auth/oauth2/delete-consent', { id: wikiConsent.id })).status).toBe(200);
    const afterRevoke = await refresh(tokens.wiki!.refresh_token!);
    expect(afterRevoke.status).toBe(400);
    expect(await afterRevoke.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('does not let a non-member connect an app', async () => {
    const notes = await authorization(RESOURCE.notes);
    const consent = redirectTarget(await browser.get(notes.url));
    const page = await (await browser.get(consent.toString())).text();
    expect(page).toContain('You are not a member of acme/notes');
    expect(page).not.toContain('value="yes"');
    const callback = redirectTarget(await browser.postForm('/consent', { oauth_query: signedQuery(consent), accept: 'yes' }));
    expect(callback.toString().startsWith(REDIRECT_URI)).toBe(true);
    expect(callback.searchParams.get('error')).toBe('access_denied');
  });

  it('rejects requests that do not name exactly one known app resource', async () => {
    const unknown = redirectTarget(await browser.get((await authorization(`${MCP_BASE}/orum/nope/mcp`)).url));
    expect(unknown.toString().startsWith(REDIRECT_URI)).toBe(true);
    expect(unknown.searchParams.get('error')).toBe('invalid_target');

    for (const auth of [await authorization(), await authorization(RESOURCE.board, RESOURCE.wiki)]) {
      const res = await browser.get(auth.url);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_target' });
    }
  });

  it('refuses a consent page whose signed query was altered', async () => {
    const auth = await authorization(RESOURCE.board);
    const url = new URL(auth.url);
    url.searchParams.set('prompt', 'consent');
    const consent = redirectTarget(await browser.get(url.toString()));
    expect(consent.pathname).toBe('/consent');
    consent.searchParams.set('resource', RESOURCE.wiki);
    expect((await browser.get(consent.toString())).status).toBe(400);
  });
});
