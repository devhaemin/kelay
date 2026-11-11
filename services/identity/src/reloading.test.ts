// Kelay ID over a registry that changes while it runs: the control API source of contract §6.
import * as oauth from 'oauth4webapi';
import type { JSONWebKeySet } from 'jose';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppSummary } from '@kelay/contracts';
import { localJwks, verifyKelayToken } from '@kelay/tokens';
import { createReloadingIdentity, mcpResourceUrl, migrateIdentity, type ReloadingIdentity } from './index.ts';
import { Browser, ISSUER, MCP_BASE, PASSWORD, createTestDatabase, testDeps, type TestDatabase } from './test-support.ts';

const CLIENT_ID = 'https://assistant.example.com/oauth/client.json';
const REDIRECT_URI = 'http://127.0.0.1:33418/callback';
const client: oauth.Client = { client_id: CLIENT_ID, token_endpoint_auth_method: 'none' };
const EMAIL = 'ada@example.com';
const BOARD: AppSummary = { app: 'ticket-board', handle: 'orum' };
const WIKI: AppSummary = { app: 'wiki', handle: 'orum' };

const fetchClientMetadataResource: ClientMetadataResourceFetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== CLIENT_ID) return new Response('not found', { status: 404 });
  return Response.json(
    {
      client_id: CLIENT_ID,
      client_name: 'Test Assistant',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    { headers: { 'cache-control': 'max-age=300' } },
  );
};

/** The control API's app list, as the test changes it. */
const registry = { apps: [] as AppSummary[], down: false, reads: 0 };
const source = {
  async list() {
    registry.reads += 1;
    if (registry.down) throw new Error('registry: the control API did not answer');
    return registry.apps;
  },
};

let db: TestDatabase;
let identity: ReloadingIdentity;
let browser: Browser;
let userId: string;
const reloads: number[] = [];
const errors: string[] = [];

// The Browser and oauth4webapi both talk to whichever instance is current.
const app = { request: (input: string, init?: RequestInit) => identity.fetch(new Request(input, init)) } as unknown as ConstructorParameters<typeof Browser>[0];
const http = () => ({
  [oauth.customFetch]: async (url: string, init: oauth.CustomFetchOptions<string, unknown>) => identity.fetch(new Request(url, init as RequestInit)),
  [oauth.allowInsecureRequests]: true,
});

function redirectTarget(res: Response): URL {
  expect([302, 303]).toContain(res.status);
  return new URL(res.headers.get('location')!, ISSUER);
}

/** Authorization code + PKCE for one app's MCP resource, with the signed-in browser accepting consent. */
async function connect(target: AppSummary) {
  const as = await oauth.processDiscoveryResponse(new URL(ISSUER), await oauth.discoveryRequest(new URL(ISSUER), { algorithm: 'oauth2', ...http() }));
  const resource = mcpResourceUrl(MCP_BASE, target.handle, target.app);
  const verifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const url = new URL(as.authorization_endpoint!);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'offline_access',
    state,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    resource,
  }).toString();
  const first = await browser.get(url.toString());
  if (first.status !== 302 && first.status !== 303) return { refused: first.status, body: await first.text() };
  // An app the person already let this assistant use skips the consent page.
  const next = redirectTarget(first);
  const callback =
    next.pathname === '/consent' ? redirectTarget(await browser.postForm('/consent', { oauth_query: next.search.slice(1), accept: 'yes' })) : next;
  if (!callback.searchParams.has('code')) return { refused: first.status, body: callback.toString() };
  const params = oauth.validateAuthResponse(as, client, callback, state);
  const res = await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), params, REDIRECT_URI, verifier, {
    ...http(),
    additionalParameters: { resource },
  });
  const tokens = await oauth.processAuthorizationCodeResponse(as, client, res);
  const jwks = localJwks((await (await identity.fetch(new Request(`${ISSUER}/api/auth/jwks`))).json()) as JSONWebKeySet);
  return { claims: await verifyKelayToken(tokens.access_token, { jwks, issuer: ISSUER, audience: resource, app: target.app }) };
}

beforeAll(async () => {
  db = await createTestDatabase();
  const deps = { ...testDeps(db.pool), fetchClientMetadataResource };
  await migrateIdentity({ ...deps, registry: { apps: {} } });
  identity = await createReloadingIdentity(deps, {
    source,
    refreshMs: 3_600_000,
    onReload: (apps) => reloads.push(apps.length),
    onError: (error) => errors.push(error.message),
  });
  browser = new Browser(app);
});

afterAll(async () => {
  identity?.stop();
  await db?.close();
});

describe('Kelay ID with apps from the control API', () => {
  it('runs before any app exists: people sign up and get tokens for apps they are members of', async () => {
    expect(reloads).toEqual([0]);
    expect((await identity.fetch(new Request(`${ISSUER}/healthz`))).status).toBe(200);
    const metadata = await identity.fetch(new Request(`${ISSUER}/.well-known/oauth-authorization-server`));
    expect(((await metadata.json()) as { issuer: string }).issuer).toBe(ISSUER);

    userId = await browser.signUp(EMAIL, 'Ada');
    await db.setMember({ app: 'kelay-console', user_id: userId, org: 'ada', role: 'builder', plan: 'free', status: 'active' });
    const token = await browser.postJson('/v1/token', { app: 'kelay-console' });
    expect(token.status).toBe(200);
    expect(identity.current().apps.list).toEqual([]);
  });

  it('refuses an assistant asking for an app that is not published', async () => {
    await db.setMember({ app: BOARD.app, user_id: userId, org: 'orum', role: 'agent', plan: 'pro', status: 'active' });
    expect(await connect(BOARD)).not.toHaveProperty('claims');
  });

  it('connects an assistant to an app published after start, keeping the session', async () => {
    registry.apps = [BOARD];
    const before = identity.current();
    await identity.refresh();
    expect(identity.current()).not.toBe(before);
    expect(reloads).toEqual([0, 1]);
    const connected = await connect(BOARD);
    expect(connected.claims).toMatchObject({ sub: userId, app: BOARD.app, org: 'orum', role: 'agent', plan: 'pro', azp: CLIENT_ID });
  });

  it('connects the same assistant to a second app published later', async () => {
    registry.apps = [BOARD, WIKI];
    await identity.refresh();
    await db.setMember({ app: WIKI.app, user_id: userId, org: 'orum', role: 'editor', plan: 'free', status: 'active' });
    expect((await connect(WIKI)).claims).toMatchObject({ app: WIKI.app, role: 'editor' });
    expect((await connect(BOARD)).claims).toMatchObject({ app: BOARD.app });
  });

  it('keeps serving the apps it knows while the control API is away, and builds nothing new for an unchanged list', async () => {
    const current = identity.current();
    registry.down = true;
    await identity.refresh();
    expect(errors).toEqual(['registry: the control API did not answer']);
    registry.down = false;
    await identity.refresh();
    expect(identity.current()).toBe(current);
    expect(reloads).toEqual([0, 1, 2]);
    expect((await connect(WIKI)).claims).toMatchObject({ app: WIKI.app });
  });
});
