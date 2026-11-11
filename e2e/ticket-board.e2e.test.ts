// The Ticket Board path across the running services, nothing mocked: Kelay ID issues the tokens,
// the Data API enforces RLS in Postgres, the Control API takes feedback, and the MCP gateway serves
// the same rows to an assistant that went through the OAuth authorization-code flow, until the builder
// revokes that assistant's consent.
import * as oauth from 'oauth4webapi';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { audienceForApp } from '@kelay/contracts';
import { KelayError, createKelayClient, sendFeedback } from '@kelay/sdk';
import { remoteJwks, signCallerToken, verifyKelayToken } from '@kelay/tokens';
import { BOARD, BUILDER, CONSENTS, CONSOLE_APP, FEEDBACK, FOREIGN_TICKET, HANDLE, ORG, PASSWORD, TEAM } from '../scripts/lib/data.ts';
import { KelayIdSession, redirectTarget } from '../scripts/lib/session.ts';
import { ASSISTANT_CLIENT_ID, ASSISTANT_REDIRECT_URI } from './assistant.ts';

const APP = 'ticket-board';
const { config, users, builderId } = inject('stack');
const person = (key: string) => TEAM.find((p) => p.key === key)!;
const resource = `${config.mcpPublicBaseUrl}/${HANDLE}/${APP}/mcp`;

/** What RLS should let Junho read: tickets assigned to him, plus the ones shared with the team. */
const visibleToJunho = BOARD.filter((t) => t.assignee === 'junho' || t.shared);
const titles = (rows: readonly object[]) => rows.map((r) => String((r as { title?: unknown }).title)).sort();

let junho: KelayIdSession;
let junhoToken: string;
const auth = {
  getUserToken: () => junhoToken,
  // What the app's own runtime sends with every call (contract §4).
  getCallerToken: () => signCallerToken({ kind: 'app-runtime', app: APP, env: 'prod' }, config.callerSecret),
};

let builderToken: Promise<string> | undefined;

async function builderCall(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  // One console token for the run; it outlives the suite (15 minutes).
  builderToken ??= (async () => {
    const session = new KelayIdSession(config.issuer);
    await session.signIn(BUILDER.email, PASSWORD);
    return session.appToken(CONSOLE_APP);
  })();
  const token = await builderToken;
  const res = await fetch(`${config.controlApiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

const builderGet = (path: string) => builderCall('GET', path);

beforeAll(async () => {
  junho = new KelayIdSession(config.issuer);
  expect(await junho.signIn(person('junho').email, PASSWORD)).toBe(users.junho);
  junhoToken = await junho.appToken(APP);
});

describe('Kelay ID', () => {
  it('gives Junho an app-scoped token carrying his membership', async () => {
    const claims = await verifyKelayToken(junhoToken, {
      jwks: remoteJwks(config.jwksUrl),
      issuer: config.issuer,
      audience: audienceForApp(APP),
      app: APP,
    });
    expect(claims).toMatchObject({ sub: users.junho, org: ORG, role: 'member', plan: 'team' });
  });

  it('refuses a token for an app the person is not a member of', async () => {
    const res = await junho.postJson('/v1/token', { app: CONSOLE_APP });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'denied' } });
  });
});

describe('Data API under Junho’s token', () => {
  const client = createKelayClient({ dataApiUrl: config.dataApiUrl, app: APP, ...auth });
  const tickets = client.collection('tickets');

  it('returns only his own tickets and the shared ones', async () => {
    const rows = await tickets.list();
    expect(titles(rows)).toEqual(titles(visibleToJunho));
    expect(rows.length).toBeLessThan(BOARD.length);
    for (const row of rows) {
      expect(row.org_id).toBe(ORG);
      expect(row.assignee_id === users.junho || row.shared === true).toBe(true);
    }
    expect(await tickets.get(FOREIGN_TICKET.id)).toBeNull();
    const hidden = BOARD.find((t) => t.assignee === 'daniel')!;
    expect(await tickets.get(hidden.id)).toBeNull();
  });

  it('lets him move his own ticket', async () => {
    const mine = BOARD.find((t) => t.assignee === 'junho' && t.status === 'todo')!;
    expect(await tickets.update(mine.id, { status: 'doing' })).toMatchObject({ id: mine.id, status: 'doing' });
    expect(await tickets.update(mine.id, { status: mine.status })).toMatchObject({ status: mine.status });
  });

  it('denies an update to someone else’s ticket, even one he can see', async () => {
    const shared = BOARD.find((t) => t.shared && t.assignee === 'seoyeon')!;
    expect(await tickets.get(shared.id)).toMatchObject({ title: shared.title });
    const attempt = tickets.update(shared.id, { status: 'done' });
    await expect(attempt).rejects.toBeInstanceOf(KelayError);
    await expect(attempt).rejects.toMatchObject({ code: 'denied', status: 403 });
    expect(await tickets.get(shared.id)).toMatchObject({ status: shared.status });
  });

  it('rejects a call without the app runtime’s caller token', async () => {
    const res = await fetch(`${config.dataApiUrl}/v1/apps/${APP}/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${junhoToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'select', collection: 'tickets' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden_caller' } });
  });
});

describe('Access rules saved in the console reach the app database', () => {
  const tickets = createKelayClient({ dataApiUrl: config.dataApiUrl, app: APP, ...auth }).collection('tickets');

  /** Saves the rules as a draft, then deploys the build that is already in Development with them. */
  async function saveAndDeploy(policy: unknown): Promise<void> {
    const saved = await builderCall('PUT', `/v1/apps/${APP}/policy`, { policy });
    expect(saved.status).toBe(200);
    const detail = await builderGet(`/v1/apps/${APP}`);
    const dev = detail.body.envs.find((e: { name: string }) => e.name === 'dev').activeVersion;
    const deployed = await builderCall('POST', `/v1/apps/${APP}/envs/dev/deploy`, { commit: dev.commit, artifactUrl: dev.artifactUrl, configVersion: dev.configVersion });
    expect(deployed.status).toBe(201);
    expect(deployed.body.version).toMatchObject({ id: saved.body.draft.id, status: 'deployed' });
  }

  it('changes what Junho reads once the builder deploys a narrower rule, and back', async () => {
    const original = (await builderGet(`/v1/apps/${APP}/schema`)).body.policy;
    expect(original.member.tickets.read).toBe('mine_shared');
    const shared = BOARD.find((t) => t.shared && t.assignee === 'seoyeon')!;
    expect(titles(await tickets.list())).toEqual(titles(visibleToJunho));

    try {
      // Saving alone is a draft: the database still answers with the deployed rules.
      const draft = await builderCall('PUT', `/v1/apps/${APP}/policy`, { policy: { ...original, member: { ...original.member, tickets: { ...original.member.tickets, read: 'mine' } } } });
      expect(draft.status).toBe(200);
      expect(titles(await tickets.list())).toEqual(titles(visibleToJunho));

      await saveAndDeploy(draft.body.draft.policy);
      expect(titles(await tickets.list())).toEqual(titles(BOARD.filter((t) => t.assignee === 'junho')));
      expect(await tickets.get(shared.id)).toBeNull();
    } finally {
      await saveAndDeploy(original);
    }
    expect(titles(await tickets.list())).toEqual(titles(visibleToJunho));
    expect(await tickets.get(shared.id)).toMatchObject({ title: shared.title });
    expect((await builderGet(`/v1/apps/${APP}/schema`)).body).toMatchObject({ policy: original, draft: null });
  });
});

describe('Feedback and the builder’s ticket board (Control API)', () => {
  const text = `The Done column is empty after I reload the board (e2e ${Date.now()})`;
  let ticketId: string;

  it('turns feedback sent through the SDK into a ticket', async () => {
    ({ ticketId } = await sendFeedback({ controlApiUrl: config.controlApiUrl, app: APP, text, route: '/board', context: { column: 'done' }, ...auth }));
    expect(ticketId).toMatch(/^FB-\d+$/);
    const seededKeys = FEEDBACK.filter((f) => f.app === APP).map((f) => Number(f.key.slice(3)));
    expect(Number(ticketId.slice(3))).toBeGreaterThan(Math.max(...seededKeys));
  });

  it('shows the builder that ticket next to the seeded ones', async () => {
    const { status, body } = await builderGet(`/v1/apps/${APP}/tickets`);
    expect(status).toBe(200);
    const keys = body.tickets.map((t: { key: string }) => t.key);
    expect(keys).toEqual(expect.arrayContaining(FEEDBACK.filter((f) => f.app === APP).map((f) => f.key)));
    expect(body.total).toBe(keys.length);
    expect(body.tickets.find((t: { key: string }) => t.key === ticketId)).toMatchObject({
      app: APP,
      text,
      route: '/board',
      source: 'in-app',
      status: 'new',
      reporter: users.junho,
      reporterOrg: ORG,
    });
  });

  it('shows the builder each member’s Kelay ID profile, and their own', async () => {
    const { status, body } = await builderGet(`/v1/apps/${APP}/members`);
    expect(status).toBe(200);
    const row = body.members.find((m: { userId: string }) => m.userId === users.junho);
    expect(row).toMatchObject({ role: 'member', name: person('junho').name, email: person('junho').email, provider: 'email' });
    // Junho signed in at the start of this run.
    expect(Date.now() - Date.parse(row.lastSignInAt)).toBeLessThan(10 * 60_000);
    expect(Date.parse(row.createdAt)).toBeLessThanOrEqual(Date.parse(row.lastSignInAt));
    expect(body.members.map((m: { name: string }) => m.name).sort()).toEqual(TEAM.map((p) => p.name).sort());
    expect((await builderGet(`/v1/apps/${APP}/members?q=${encodeURIComponent('junho@')}`)).body.members.map((m: { userId: string }) => m.userId)).toEqual([users.junho]);

    const me = await builderGet('/v1/me');
    expect(me.body.me).toMatchObject({ userId: builderId, name: BUILDER.name, email: BUILDER.email, provider: 'email', handle: HANDLE, org: ORG, role: 'builder' });
  });

  it('lists the builder’s apps and keeps an app user off the builder routes', async () => {
    const apps = await builderGet('/v1/apps');
    expect(apps.body.apps.find((a: { slug: string }) => a.slug === APP)).toMatchObject({ handle: HANDLE, owner: builderId, status: 'live', members: TEAM.length });
    const res = await fetch(`${config.controlApiUrl}/v1/apps/${APP}/tickets`, { headers: { authorization: `Bearer ${junhoToken}` } });
    expect(res.status).toBe(401);
  });
});

describe('MCP gateway with a token from the OAuth authorization-code flow', () => {
  const client: oauth.Client = { client_id: ASSISTANT_CLIENT_ID, token_endpoint_auth_method: 'none' };
  const insecure = { [oauth.allowInsecureRequests]: true };
  let as: oauth.AuthorizationServer;
  let accessToken: string;
  let refreshToken: string;

  it('challenges a call without a token and points at Kelay ID', async () => {
    const res = await fetch(resource, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') ?? '')?.[1];
    expect(metadataUrl).toBeTruthy();
    expect(await (await fetch(metadataUrl!)).json()).toMatchObject({ resource, authorization_servers: [config.issuer] });
  });

  it('refuses the screen token: it is not bound to the MCP resource', async () => {
    const res = await fetch(resource, { method: 'POST', headers: { authorization: `Bearer ${junhoToken}`, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('issues a resource-bound token after Junho consents', async () => {
    const issuer = new URL(config.issuer);
    as = await oauth.processDiscoveryResponse(issuer, await oauth.discoveryRequest(issuer, { algorithm: 'oauth2', ...insecure }));
    const verifier = oauth.generateRandomCodeVerifier();
    const state = oauth.generateRandomState();
    const authorize = new URL(as.authorization_endpoint!);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: ASSISTANT_CLIENT_ID,
      redirect_uri: ASSISTANT_REDIRECT_URI,
      scope: 'offline_access',
      state,
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      resource,
    }).toString();

    // Junho is already signed in, so Kelay ID goes straight to the consent page for this app.
    const consent = await redirectTarget(await junho.get(authorize.toString()), config.issuer);
    expect(consent.pathname).toBe('/consent');
    const page = await (await junho.get(consent.toString())).text();
    expect(page).toContain(`<strong>E2E Assistant</strong> wants to use <strong>${HANDLE}/${APP}</strong> as you.`);
    expect(page).toContain('member, team plan');

    const callback = await redirectTarget(await junho.postForm('/consent', { oauth_query: consent.search.slice(1), accept: 'yes' }), config.issuer);
    expect(callback.toString().startsWith(ASSISTANT_REDIRECT_URI)).toBe(true);
    const params = oauth.validateAuthResponse(as, client, callback, state);
    const res = await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), params, ASSISTANT_REDIRECT_URI, verifier, {
      ...insecure,
      additionalParameters: { resource },
    });
    const tokens = await oauth.processAuthorizationCodeResponse(as, client, res);
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token!;

    const claims = await verifyKelayToken(accessToken, { jwks: remoteJwks(config.jwksUrl), issuer: config.issuer, audience: resource, app: APP });
    expect(claims).toMatchObject({ sub: users.junho, azp: ASSISTANT_CLIENT_ID, org: ORG, role: 'member' });
  });

  it('lists the app’s tools and returns the same tickets the screen sees', async () => {
    const mcp = new Client({ name: 'e2e-assistant', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: { token: async () => accessToken } }));
    try {
      const { tools } = await mcp.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['tickets_list', 'tickets_update', 'comments_create', 'action_summarize_overdue']));

      const listed = await mcp.callTool({ name: 'tickets_list', arguments: {} });
      expect(listed.isError).toBeFalsy();
      const viaMcp = (listed.structuredContent as { rows: { id: string; title: string }[] }).rows;
      const viaScreen = await createKelayClient({ dataApiUrl: config.dataApiUrl, app: APP, ...auth }).collection('tickets').list();
      expect(viaMcp.map((r) => r.id).sort()).toEqual(viaScreen.map((r) => r.id).sort());
      expect(titles(viaMcp)).toEqual(titles(visibleToJunho));

      const shared = BOARD.find((t) => t.shared && t.assignee === 'seoyeon')!;
      const denied = await mcp.callTool({ name: 'tickets_update', arguments: { id: shared.id, values: { status: 'done' } } });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toContain('permission');
    } finally {
      await mcp.close();
    }
  });

  it('shows the builder those tool calls next to the seeded assistants’ calls', async () => {
    type Call = { clientId: string; clientName: string | null; tool: string; result: string; userId: string; args: string };
    // The gateway posts call records to the Control API in the background, a couple of seconds after the call.
    let mine: Call[] = [];
    let all: Call[] = [];
    await expect
      .poll(
        async () => {
          all = (await builderGet(`/v1/apps/${APP}/tool-calls?limit=500`)).body.toolCalls;
          mine = all.filter((c) => c.clientId === ASSISTANT_CLIENT_ID);
          return mine.length;
        },
        { timeout: 15_000, interval: 500 },
      )
      .toBe(2);
    // Newest first.
    expect(mine.map((c) => [c.tool, c.result, c.userId])).toEqual([
      ['tickets_update', 'denied', users.junho],
      ['tickets_list', 'ok', users.junho],
    ]);
    expect(mine[0]!.args).toContain(BOARD.find((t) => t.shared && t.assignee === 'seoyeon')!.id);

    // Seeded history from the two assistants members connected, each tied to its consent.
    const seeded = all.filter((c) => c.clientId !== ASSISTANT_CLIENT_ID);
    expect(seeded.length).toBeGreaterThan(50);
    expect(new Set(seeded.map((c) => c.clientName))).toEqual(new Set(CONSENTS.map((c) => c.clientName)));
    expect(seeded.every((c) => (c as Call & { consentId: string | null }).consentId)).toBe(true);

    const { metrics } = (await builderGet(`/v1/apps/${APP}/metrics?range=14d`)).body;
    expect(metrics.series.actions).toHaveLength(14);
    expect(metrics.series.actions.filter((n: number) => n > 0).length).toBeGreaterThanOrEqual(13);
    expect(metrics.activeMembers).toMatchObject({ value: TEAM.length, total: TEAM.length });
    expect(metrics.recent[0]).toMatchObject({ action: 'tickets_update', status: 'blocked', by: users.junho, caller: { kind: 'agent', id: ASSISTANT_CLIENT_ID } });
  });

  it('shows the builder the assistant by name, and ends its access at the next refresh once revoked', async () => {
    type Consent = { id: string; userId: string; clientId: string; clientName: string | null; scopes: string[]; active: boolean };
    const connected = (await builderGet(`/v1/apps/${APP}/consents`)).body.consents as Consent[];
    const mine = connected.filter((c) => c.clientId === ASSISTANT_CLIENT_ID);
    // Kelay ID recorded it when Junho chose Allow; the name is the one in the assistant's metadata document.
    expect(mine).toEqual([expect.objectContaining({ userId: users.junho, clientName: 'E2E Assistant', scopes: ['offline_access'], active: true })]);
    expect(connected.map((c) => c.clientName).sort()).toEqual(['E2E Assistant', ...CONSENTS.map((c) => c.clientName)].sort());

    // While the consent stands, the assistant can refresh.
    const refreshed = await oauth.processRefreshTokenResponse(as, client, await oauth.refreshTokenGrantRequest(as, client, oauth.None(), refreshToken, insecure));
    expect(await verifyKelayToken(refreshed.access_token, { jwks: remoteJwks(config.jwksUrl), issuer: config.issuer, audience: resource, app: APP })).toMatchObject({ sub: users.junho });

    const revoked = await builderCall('POST', `/v1/apps/${APP}/consents/${mine[0]!.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.consent).toMatchObject({ id: mine[0]!.id, active: false });

    const afterRevoke = await oauth.refreshTokenGrantRequest(as, client, oauth.None(), refreshed.refresh_token!, insecure);
    expect(afterRevoke.status).toBe(400);
    expect(await afterRevoke.json()).toMatchObject({ error: 'invalid_grant' });
    const left = (await builderGet(`/v1/apps/${APP}/consents`)).body.consents as Consent[];
    expect(left.map((c) => c.clientName).sort()).toEqual(CONSENTS.map((c) => c.clientName).sort());

    // Connecting again is a new decision: Kelay ID asks Junho instead of sending the assistant straight back.
    const authorize = new URL(as.authorization_endpoint!);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: ASSISTANT_CLIENT_ID,
      redirect_uri: ASSISTANT_REDIRECT_URI,
      scope: 'offline_access',
      state: oauth.generateRandomState(),
      code_challenge: await oauth.calculatePKCECodeChallenge(oauth.generateRandomCodeVerifier()),
      code_challenge_method: 'S256',
      resource,
    }).toString();
    expect((await redirectTarget(await junho.get(authorize.toString()), config.issuer)).pathname).toBe('/consent');
  });
});
