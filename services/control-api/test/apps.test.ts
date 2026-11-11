import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AppList, AppRegistryEntry } from '@kelay/contracts';
import { defaultRole } from '../src/routes/internal.ts';
import { createHarness, type Harness } from './harness.ts';

const fixture = (p: string) => JSON.parse(readFileSync(new URL(`../../../packages/contracts/fixtures/ticket-board/${p}`, import.meta.url), 'utf8'));
const schema = fixture('schema.json');
const policy = fixture('policy.json');

let h: Harness;
let jy: string;
beforeAll(async () => {
  h = await createHarness();
  jy = await h.builder('jeongyun');
});
afterAll(() => h.close());

describe('apps', () => {
  it('creates apps under the builder handle, with dev and prod envs', async () => {
    const noHandle = await h.req('POST', '/v1/apps', { token: jy, body: { slug: 'ticket-board', name: 'Ticket Board' } });
    expect(noHandle.status).toBe(400);

    const created = await h.req('POST', '/v1/apps', {
      token: jy,
      body: { slug: 'ticket-board', name: 'Ticket Board', handle: 'jeongyun', emoji: '🎫', description: 'Jira-style board' },
    });
    expect(created.status).toBe(201);
    expect(created.body.app).toMatchObject({ slug: 'ticket-board', handle: 'jeongyun', status: 'draft', listed: true, path: '/jeongyun/ticket-board' });

    const second = await h.req('POST', '/v1/apps', { token: jy, body: { slug: 'team-wiki', name: 'Team Wiki' } });
    expect(second.body.app.handle).toBe('jeongyun');
    expect((await h.req('POST', '/v1/apps', { token: jy, body: { slug: 'docs', name: 'Docs', handle: 'other' } })).status).toBe(409);
    expect((await h.req('POST', '/v1/apps', { token: jy, body: { slug: 'ticket-board', name: 'Again' } })).status).toBe(409);

    const someoneElse = await h.builder('mallory');
    const taken = await h.req('POST', '/v1/apps', { token: someoneElse, body: { slug: 'evil', name: 'Evil', handle: 'jeongyun' } });
    expect(taken.status).toBe(409);
    expect((await h.req('POST', '/v1/apps', { token: someoneElse, body: { slug: 'team-wiki', name: 'Dup', handle: 'mallory' } })).status).toBe(409);

    const detail = await h.req('GET', '/v1/apps/ticket-board', { token: jy });
    expect(detail.body.envs.map((e: { name: string }) => e.name)).toEqual(['dev', 'prod']);
    expect(detail.body.envs.every((e: { hasDatabase: boolean; activeVersion: unknown }) => e.hasDatabase && e.activeVersion === null)).toBe(true);
  });

  it('lists, updates and archives apps', async () => {
    await h.req('POST', '/v1/apps', { token: jy, body: { slug: 'lead-qualifier', name: 'Lead Qualifier' } });
    const list = await h.req('GET', '/v1/apps', { token: jy });
    expect(list.body.apps.map((a: { slug: string }) => a.slug)).toEqual(['ticket-board', 'team-wiki', 'lead-qualifier']);
    expect(list.body.apps[0]).toMatchObject({ members: 0, newFeedback: 0, pendingProposals: 0 });

    const patched = await h.req('PATCH', '/v1/apps/team-wiki', { token: jy, body: { status: 'live', description: 'Notion-style pages' } });
    expect(patched.body.app).toMatchObject({ status: 'live', description: 'Notion-style pages' });
    expect((await h.req('PATCH', '/v1/apps/team-wiki', { token: jy, body: { status: 'archived' } })).status).toBe(400);

    const archived = await h.req('DELETE', '/v1/apps/lead-qualifier', { token: jy });
    expect(archived.body.app).toMatchObject({ status: 'archived', listed: false });
    expect((await h.req('GET', '/v1/apps/lead-qualifier', { token: jy })).status).toBe(404);
    expect((await h.req('GET', '/v1/apps', { token: jy })).body.apps).toHaveLength(2);
  });
});

describe('members', () => {
  it('upserts memberships through the internal route and lists them with counts', async () => {
    const svc = await h.service('identity');
    for (const [user, role] of [['u1', 'member'], ['u2', 'member'], ['u3', 'admin']] as const) {
      const res = await h.req('PUT', `/internal/v1/apps/ticket-board/members/${user}`, { caller: svc, body: { org: 'orum', role } });
      expect(res.status).toBe(200);
    }
    await h.req('PUT', '/internal/v1/apps/ticket-board/members/u5', { caller: svc, body: { org: 'orum', status: 'unconfirmed' } });

    const list = await h.req('GET', '/v1/apps/ticket-board/members', { token: jy });
    expect(list.body.members).toHaveLength(4);
    // Kelay ID's tables are not in this database yet, so the profile fields are empty.
    expect(list.body.members[0]).toEqual({ app: 'ticket-board', userId: 'u1', org: 'orum', role: 'member', plan: 'free', status: 'active', name: null, email: null, provider: null, createdAt: null, lastSignInAt: null });
    expect(list.body.counts).toEqual({ all: 4, active: 3, unconfirmed: 1, banned: 0, admin: 1 });
    expect((await h.req('GET', '/v1/apps/ticket-board/members?status=unconfirmed', { token: jy })).body.members.map((m: { userId: string }) => m.userId)).toEqual(['u5']);
  });

  it('changes plan and role, bans and unbans, and deletes', async () => {
    const plan = await h.req('PATCH', '/v1/apps/ticket-board/members/u1', { token: jy, body: { plan: 'pro', role: 'admin' } });
    expect(plan.body.member).toMatchObject({ plan: 'pro', role: 'admin' });

    const ban = await h.req('PATCH', '/v1/apps/ticket-board/members/u2', { token: jy, body: { status: 'banned' } });
    expect(ban.body.member.status).toBe('banned');
    // Kelay ID re-upserting a banned member must not unban them.
    const again = await h.req('PUT', '/internal/v1/apps/ticket-board/members/u2', { caller: await h.service('identity'), body: { org: 'orum' } });
    expect(again.body.member.status).toBe('banned');
    expect((await h.req('PATCH', '/v1/apps/ticket-board/members/u2', { token: jy, body: { status: 'active' } })).body.member.status).toBe('active');

    expect((await h.req('PATCH', '/v1/apps/ticket-board/members/nobody', { token: jy, body: { plan: 'pro' } })).status).toBe(404);
    expect((await h.req('PATCH', '/v1/apps/ticket-board/members/u1', { token: jy, body: {} })).status).toBe(400);

    expect((await h.req('DELETE', '/v1/apps/ticket-board/members/u5', { token: jy })).body).toEqual({ deleted: true });
    expect((await h.req('DELETE', '/v1/apps/ticket-board/members/u5', { token: jy })).status).toBe(404);
  });

  it('checks roles against the deployed schema', async () => {
    await h.req('POST', '/v1/apps/ticket-board/envs/dev/deploy', {
      token: jy,
      body: { commit: 'abc123', artifactUrl: 's3://builds/ticket-board/abc123.zip', configVersion: 'c1', schema, policy },
    });
    const bad = await h.req('PATCH', '/v1/apps/ticket-board/members/u1', { token: jy, body: { role: 'owner' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('admin, member, guest');
    expect((await h.req('PATCH', '/v1/apps/ticket-board/members/u1', { token: jy, body: { role: 'guest' } })).status).toBe(200);
  });

  it('adds the Kelay ID profile to members and answers GET /v1/me', async () => {
    const me = await h.req('GET', '/v1/me', { token: jy });
    expect(me.body.me).toEqual({ userId: 'jeongyun', name: null, email: null, provider: null, createdAt: null, lastSignInAt: null, app: 'kelay-console', org: 'kelay', role: 'builder', plan: 'pro', handle: 'jeongyun' });

    // The columns of better-auth's tables that the control API reads.
    await h.database.pool.query(`
      create table "user" (id text primary key, name text not null, email text not null, "createdAt" timestamptz not null);
      create table account (id text primary key, "userId" text not null, "providerId" text not null, "createdAt" timestamptz not null);
      create table session (id text primary key, "userId" text not null, "createdAt" timestamptz not null);
      insert into "user" values ('u1', 'Mina Kim', 'mina@orum.test', '2026-10-01T00:00:00Z'), ('u2', 'Daniel Park', 'daniel@orum.test', '2026-10-02T00:00:00Z'), ('jeongyun', 'Jeongyun Lee', 'jeongyun@orum.test', '2026-09-01T00:00:00Z');
      insert into account values ('a1', 'u1', 'credential', '2026-10-01T00:00:00Z'), ('a2', 'u1', 'github', '2026-10-05T00:00:00Z'), ('a3', 'u2', 'google', '2026-10-02T00:00:00Z');
      insert into session values ('s1', 'u1', '2026-11-01T09:00:00Z'), ('s2', 'u1', '2026-11-10T09:00:00Z');`);

    const list = await h.req('GET', '/v1/apps/ticket-board/members', { token: jy });
    const byId = Object.fromEntries(list.body.members.map((m: { userId: string }) => [m.userId, m]));
    expect(byId.u1).toMatchObject({ role: 'guest', name: 'Mina Kim', email: 'mina@orum.test', provider: 'email', createdAt: '2026-10-01T00:00:00.000Z', lastSignInAt: '2026-11-10T09:00:00.000Z' });
    expect(byId.u2).toMatchObject({ name: 'Daniel Park', provider: 'google', lastSignInAt: null });
    expect(byId.u3).toMatchObject({ name: null, email: null, provider: null });
    expect(list.body.counts.all).toBe(list.body.members.length);

    // Search covers the name and email as well as the id.
    const found = async (q: string) => (await h.req('GET', `/v1/apps/ticket-board/members?q=${encodeURIComponent(q)}`, { token: jy })).body.members.map((m: { userId: string }) => m.userId);
    expect(await found('mina')).toEqual(['u1']);
    expect(await found('DANIEL@orum')).toEqual(['u2']);
    expect(await found('u3')).toEqual(['u3']);

    const patched = await h.req('PATCH', '/v1/apps/ticket-board/members/u2', { token: jy, body: { plan: 'team' } });
    expect(patched.body.member).toMatchObject({ plan: 'team', name: 'Daniel Park', email: 'daniel@orum.test' });

    expect((await h.req('GET', '/v1/me', { token: jy })).body.me).toMatchObject({ name: 'Jeongyun Lee', email: 'jeongyun@orum.test', provider: null, handle: 'jeongyun' });
    // A person who builds nothing has no handle; an app token must come through its app's runtime.
    expect((await h.req('GET', '/v1/me', { token: await h.builder('stranger') })).body.me).toMatchObject({ userId: 'stranger', handle: null });
    expect((await h.req('GET', '/v1/me', { token: await h.appUser('ticket-board', 'u1') })).status).toBe(403);
    expect((await h.req('GET', '/v1/me', { token: await h.appUser('ticket-board', 'u1'), caller: await h.appCaller('ticket-board') })).body.me).toMatchObject({ name: 'Mina Kim', app: 'ticket-board', role: 'member', handle: null });
    expect((await h.req('GET', '/v1/me')).status).toBe(401);
  });

  it('gives new members a role the app declares', async () => {
    const svc = await h.service('identity');
    const res = await h.req('PUT', '/internal/v1/apps/ticket-board/members/u7', { caller: svc, body: { org: 'orum' } });
    expect(res.body.member).toMatchObject({ role: 'member', plan: 'free', status: 'active' });
    expect(defaultRole(null)).toBe('member');
    expect(defaultRole(['admin', 'editor', 'viewer'])).toBe('editor');
    expect(defaultRole(['admin'])).toBe('admin');
  });
});

describe('internal registry and public store', () => {
  it('serves the AppRegistryEntry for the active version of an env', async () => {
    const svc = await h.service('data-api');
    const prod = await h.req('GET', '/internal/v1/apps/ticket-board', { caller: svc });
    expect(prod.status).toBe(404);
    expect(prod.body.error.code).toBe('unknown_app');

    const dev = await h.req('GET', '/internal/v1/apps/ticket-board?env=dev', { caller: svc });
    expect(dev.status).toBe(200);
    const entry = AppRegistryEntry.parse(dev.body);
    expect(entry).toEqual({ handle: 'jeongyun', databaseUrl: 'postgres://kelay:kelay@localhost:54320/app_ticket_board_dev', schema, policy });

    const moved = await h.req('PUT', '/internal/v1/apps/ticket-board/envs/dev', { caller: svc, body: { databaseUrl: 'postgres://proxy/app_ticket_board_dev' } });
    expect(moved.status).toBe(200);
    expect((await h.req('GET', '/internal/v1/apps/ticket-board?env=dev', { caller: svc })).body.databaseUrl).toBe('postgres://proxy/app_ticket_board_dev');
    expect((await h.req('GET', '/internal/v1/apps/nope', { caller: svc })).status).toBe(404);
  });

  it('lists only live, listed apps on the store page', async () => {
    await h.req('PATCH', '/v1/apps/ticket-board', { token: jy, body: { status: 'live' } });
    await h.req('POST', '/v1/apps', { token: jy, body: { slug: 'docs', name: 'Docs' } });
    await h.req('PATCH', '/v1/apps/docs', { token: jy, body: { status: 'live', listed: false } });

    const store = await h.req('GET', '/public/v1/stores/jeongyun');
    expect(store.status).toBe(200);
    expect(store.body.apps.map((a: { slug: string }) => a.slug)).toEqual(['team-wiki', 'ticket-board']);
    expect(store.body.apps[1]).toEqual({ slug: 'ticket-board', name: 'Ticket Board', description: 'Jira-style board', emoji: '🎫', color: null, path: '/jeongyun/ticket-board' });
    expect((await h.req('GET', '/public/v1/stores/nobody')).status).toBe(404);
  });

  it('lists the apps that have a deployment and a database in an env', async () => {
    const svc = await h.service('identity');
    expect((await h.req('GET', '/internal/v1/apps', { caller: svc })).body).toEqual({ apps: [] });
    const dev = await h.req('GET', '/internal/v1/apps?env=dev', { caller: svc });
    expect(dev.status).toBe(200);
    expect(AppList.parse(dev.body)).toEqual({ apps: [{ app: 'ticket-board', handle: 'jeongyun' }] });
    for (const { app } of dev.body.apps) expect((await h.req('GET', `/internal/v1/apps/${app}?env=dev`, { caller: svc })).status).toBe(200);

    expect((await h.req('GET', '/internal/v1/apps?env=test', { caller: svc })).status).toBe(400);
    expect((await h.req('GET', '/internal/v1/apps')).status).toBe(403);
    expect((await h.req('GET', '/internal/v1/apps', { caller: await h.appCaller('ticket-board') })).status).toBe(403);

    await h.req('DELETE', '/v1/apps/ticket-board', { token: jy });
    expect((await h.req('GET', '/internal/v1/apps?env=dev', { caller: svc })).body).toEqual({ apps: [] });
  });
});
