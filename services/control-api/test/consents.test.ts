import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audienceForApp } from '@kelay/contracts';
import { CONSOLE_APP } from '../src/auth.ts';
import { createHarness, seedApp, type Harness } from './harness.ts';

let h: Harness;
let builder: string;
const CLAUDE = 'https://claude.ai/oauth/mcp-client.json';
const CURSOR = 'https://cursor.com/.well-known/mcp-client.json';

beforeAll(async () => {
  h = await createHarness();
  builder = await seedApp(h, 'jeongyun', 'ticket-board');
  await h.req('POST', '/v1/apps', { token: builder, body: { slug: 'team-wiki', name: 'Team Wiki' } });
  const svc = await h.service('identity');
  for (const [userId, app, clientId, clientName] of [
    ['mina', 'ticket-board', CLAUDE, 'Claude Desktop'],
    ['mina', 'team-wiki', CLAUDE, 'Claude Desktop'],
    ['daniel', 'ticket-board', CURSOR, 'Cursor'],
  ] as const) {
    const res = await h.req('PUT', '/internal/v1/consents', { caller: svc, body: { userId, app, clientId, clientName, scopes: ['tickets:read', 'tickets:write'] } });
    expect(res.status).toBe(200);
  }
});
afterAll(() => h.close());

const consoleToken = (sub: string) => h.signer.sign({ sub, app: CONSOLE_APP, aud: audienceForApp(CONSOLE_APP), org: 'orum', role: 'member', plan: 'free' });

describe('consents', () => {
  it('upserts one active consent per user × app × client', async () => {
    const svc = await h.service('identity');
    const again = await h.req('PUT', '/internal/v1/consents', { caller: svc, body: { userId: 'mina', app: 'ticket-board', clientId: CLAUDE, scopes: ['tickets:read'] } });
    expect(again.body.consent.scopes).toEqual(['tickets:read']);
    const mine = await h.req('GET', '/v1/me/consents', { token: await consoleToken('mina') });
    expect(mine.body.consents).toHaveLength(2);
  });

  it('lists the current user’s consents: all apps from the console, one app from inside the app', async () => {
    const fromConsole = await h.req('GET', '/v1/me/consents', { token: await consoleToken('mina') });
    expect(fromConsole.body.consents.map((x: { app: string }) => x.app).sort()).toEqual(['team-wiki', 'ticket-board']);

    const appToken = await h.appUser('ticket-board', 'mina');
    expect((await h.req('GET', '/v1/me/consents', { token: appToken })).status).toBe(403);
    const fromApp = await h.req('GET', '/v1/me/consents', { token: appToken, caller: await h.appCaller('ticket-board') });
    expect(fromApp.body.consents).toEqual([expect.objectContaining({ app: 'ticket-board', clientId: CLAUDE, clientName: 'Claude Desktop', active: true })]);
    expect((await h.req('GET', '/v1/me/consents', { token: appToken, caller: await h.appCaller('team-wiki') })).status).toBe(403);
  });

  it('revokes only the caller’s own consent and the gateway sees it', async () => {
    const svc = await h.service('mcp-gateway');
    const daniel = (await h.req('GET', '/v1/me/consents', { token: await consoleToken('daniel') })).body.consents[0];
    expect((await h.req('POST', `/v1/me/consents/${daniel.id}/revoke`, { token: await consoleToken('mina') })).status).toBe(404);

    const minaApp = await h.appUser('ticket-board', 'mina');
    const caller = await h.appCaller('ticket-board');
    const [own] = (await h.req('GET', '/v1/me/consents', { token: minaApp, caller })).body.consents;
    const check = `/internal/v1/consents/check?userId=mina&app=ticket-board&clientId=${encodeURIComponent(CLAUDE)}`;
    expect((await h.req('GET', check, { caller: svc })).body.active).toBe(true);

    const revoked = await h.req('POST', `/v1/me/consents/${own.id}/revoke`, { token: minaApp, caller });
    expect(revoked.body.consent).toMatchObject({ id: own.id, active: false });
    expect(revoked.body.consent.revokedAt).toBeTruthy();
    expect((await h.req('GET', check, { caller: svc })).body).toEqual({ active: false, consent: null });

    expect((await h.req('GET', '/v1/me/consents', { token: minaApp, caller })).body.consents).toEqual([]);
    const history = await h.req('GET', '/v1/me/consents?include=all', { token: minaApp, caller });
    expect(history.body.consents).toHaveLength(1);

    // An app-scoped token cannot reach consents of another app.
    const wiki = (await h.req('GET', '/v1/me/consents', { token: await consoleToken('mina') })).body.consents.find((x: { app: string }) => x.app === 'team-wiki');
    expect((await h.req('POST', `/v1/me/consents/${wiki.id}/revoke`, { token: minaApp, caller })).status).toBe(404);
  });

  it('shows the builder which assistants are connected to an app', async () => {
    const res = await h.req('GET', '/v1/apps/ticket-board/consents', { token: builder });
    expect(res.body.consents.map((x: { userId: string; clientName: string }) => `${x.userId}:${x.clientName}`)).toEqual(['daniel:Cursor']);
    expect((await h.req('GET', '/v1/apps/ticket-board/consents', { token: await h.builder('stranger') })).status).toBe(403);
  });
});
