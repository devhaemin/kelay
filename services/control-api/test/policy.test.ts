import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, seedApp, ticketBoardPolicy, ticketBoardSchema, type Harness } from './harness.ts';

let h: Harness;
let builder: string;
let boardSql: Awaited<ReturnType<Harness['appDatabase']>>['sql'];
const APP = 'ticket-board';

const P = '00000000-0000-4000-8000-000000000001';
const T = {
  minaPrivate: '00000000-0000-4000-8000-0000000000a1',
  danielPrivate: '00000000-0000-4000-8000-0000000000b1',
  danielShared: '00000000-0000-4000-8000-0000000000b2',
  acme: '00000000-0000-4000-8000-0000000000d1',
};

const membersOnly = { ...ticketBoardPolicy, member: { ...ticketBoardPolicy.member, tickets: { read: 'mine', create: 'all', update: 'mine', delete: 'mine' } } };

beforeAll(async () => {
  h = await createHarness();
  builder = await seedApp(h, 'jeongyun', APP);
  await h.req('POST', '/v1/apps', { token: builder, body: { slug: 'team-wiki', name: 'Team Wiki' } });
});
afterAll(() => h.close());

describe('schema and access rules', () => {
  it('has nothing to show before the first deploy to dev', async () => {
    expect((await h.req('GET', `/v1/apps/${APP}/schema`, { token: builder })).body).toMatchObject({ error: { code: 'not_found' } });
    expect((await h.req('PUT', `/v1/apps/${APP}/policy`, { token: builder, body: { policy: ticketBoardPolicy } })).status).toBe(404);
  });

  it('returns the schema and policy of the active dev version', async () => {
    const { sql } = await h.appDatabase(APP, builder);
    boardSql = sql;
    await sql(`INSERT INTO app.projects (id, org_id, owner_id, name) VALUES ($1, 'orum', 'jiwoo', 'Launch')`, [P]);
    await sql(
      `INSERT INTO app.tickets (id, org_id, owner_id, title, status, assignee_id, shared, project_id, created_at) VALUES
        ($1, 'orum', 'jiwoo',  'Mina private',   'todo',  'mina',   false, $5, now() - interval '3 minutes'),
        ($2, 'orum', 'jiwoo',  'Daniel private', 'todo',  'daniel', false, $5, now() - interval '2 minutes'),
        ($3, 'orum', 'daniel', 'Daniel shared',  'doing', 'daniel', true,  $5, now() - interval '1 minute'),
        ($4, 'acme', 'mina',   'Acme ticket',    'todo',  'mina',   true,  NULL, now())`,
      [T.minaPrivate, T.danielPrivate, T.danielShared, T.acme, P],
    );
    await sql(`INSERT INTO app.comments (org_id, owner_id, ticket_id, body) VALUES ('orum', 'mina', $1, 'mine'), ('orum', 'daniel', $2, 'his')`, [T.minaPrivate, T.danielShared]);

    const res = await h.req('GET', `/v1/apps/${APP}/schema`, { token: builder });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      schema: ticketBoardSchema,
      policy: ticketBoardPolicy,
      notes: [],
      version: { id: expect.any(String), number: 1, label: 'v1', createdBy: 'jeongyun', createdAt: expect.any(String) },
      draft: null,
    });
    expect((await h.req('GET', `/v1/apps/${APP}/schema`, { token: await h.builder('stranger') })).status).toBe(403);
    expect((await h.req('GET', `/v1/apps/${APP}/schema`, { caller: await h.service() })).status).toBe(401);
  });

  it('rejects a policy that does not fit the schema and names every problem', async () => {
    const bad = { ...ticketBoardPolicy, owner: ticketBoardPolicy.admin, member: { invoices: ticketBoardPolicy.member.tickets } };
    const res = await h.req('PUT', `/v1/apps/${APP}/policy`, { token: builder, body: { policy: bad } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(res.body.error.message).toContain('role "owner" is not declared');
    expect(res.body.error.message).toContain('collection "invoices" is not declared');
    expect((await h.req('PUT', `/v1/apps/${APP}/policy`, { token: builder, body: { policy: { member: { tickets: { read: 'everyone' } } } } })).status).toBe(400);
    expect((await h.req('PUT', `/v1/apps/${APP}/policy`, { token: await h.builder('stranger'), body: { policy: membersOnly } })).status).toBe(403);
  });

  it('stores saved rules as one draft version and leaves the deployed policy alone', async () => {
    const saved = await h.req('PUT', `/v1/apps/${APP}/policy`, { token: builder, body: { policy: membersOnly } });
    expect(saved.status).toBe(200);
    expect(saved.body.policy).toEqual(ticketBoardPolicy);
    expect(saved.body.draft).toMatchObject({ number: 2, label: 'v2', createdBy: 'jeongyun', policy: membersOnly });

    const again = await h.req('PUT', `/v1/apps/${APP}/policy`, { token: builder, body: { policy: { ...membersOnly, guest: {} } } });
    expect(again.body.draft).toMatchObject({ id: saved.body.draft.id, number: 2, policy: { guest: {} } });
    await h.req('PUT', `/v1/apps/${APP}/policy`, { token: builder, body: { policy: membersOnly } });

    const shown = await h.req('GET', `/v1/apps/${APP}/schema`, { token: builder });
    expect(shown.body).toMatchObject({ policy: ticketBoardPolicy, version: { number: 1 }, draft: { number: 2, policy: membersOnly } });

    // A draft is not a deployed version: it is not listed, not active, and cannot be published.
    const versions = await h.req('GET', `/v1/apps/${APP}/versions`, { token: builder });
    expect(versions.body.versions.map((v: { label: string }) => v.label)).toEqual(['v1']);
    const detail = await h.req('GET', `/v1/apps/${APP}`, { token: builder });
    expect(detail.body.envs.find((e: { name: string }) => e.name === 'dev').activeVersion.label).toBe('v1');
    const publish = await h.req('POST', `/v1/apps/${APP}/publish`, { token: builder, body: { versionId: saved.body.draft.id } });
    expect(publish.body).toMatchObject({ error: { code: 'conflict' } });
  });

  it('turns the draft into the next dev version when the app is deployed', async () => {
    const draftId = (await h.req('GET', `/v1/apps/${APP}/schema`, { token: builder })).body.draft.id;
    const deployed = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, {
      token: builder,
      body: { commit: 'b2', artifactUrl: `s3://kelay-builds/${APP}/b2.zip`, configVersion: 'cfg-b2' },
    });
    expect(deployed.status).toBe(201);
    expect(deployed.body.version).toMatchObject({ id: draftId, number: 2, status: 'deployed', commit: 'b2', lambdaVersion: 'local-2' });

    const shown = await h.req('GET', `/v1/apps/${APP}/schema`, { token: builder });
    expect(shown.body).toMatchObject({ schema: ticketBoardSchema, policy: membersOnly, version: { number: 2 }, draft: null });

    // A later build that sends nothing about access keeps the rules.
    const next = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, {
      token: builder,
      body: { commit: 'c3', artifactUrl: `s3://kelay-builds/${APP}/c3.zip`, configVersion: 'cfg-c3' },
    });
    expect(next.body.version.number).toBe(3);
    expect((await h.req('GET', `/v1/apps/${APP}/schema`, { token: builder })).body.policy).toEqual(membersOnly);
    const bad = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, {
      token: builder,
      body: { commit: 'd4', artifactUrl: `s3://kelay-builds/${APP}/d4.zip`, configVersion: 'cfg-d4', policy: { owner: {} } },
    });
    expect(bad.status).toBe(400);
  });
});

describe('preview as a member', () => {
  const preview = (as: string, token = builder) => h.req('POST', `/v1/apps/${APP}/policy/preview`, { token, body: { as } });
  const collection = (body: { preview: { collections: { collection: string }[] } }, name: string) => body.preview.collections.find((c) => c.collection === name) as any;

  beforeAll(async () => {
    const svc = await h.service('identity');
    for (const [userId, role, org] of [['mina', 'member', 'orum'], ['jiwoo', 'admin', 'orum'], ['gina', 'guest', 'orum'], ['zed', 'admin', 'acme']] as const) {
      await h.req('PUT', `/internal/v1/apps/${APP}/members/${userId}`, { caller: svc, body: { org, role } });
    }
    // Back to the fixture policy, which is what the app database was migrated with.
    await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, {
      token: builder,
      body: { commit: 'e5', artifactUrl: `s3://kelay-builds/${APP}/e5.zip`, configVersion: 'cfg-e5', policy: ticketBoardPolicy },
    });
  });

  it('counts what a member can read, update and delete through RLS, with the rows', async () => {
    const res = await preview('mina');
    expect(res.status).toBe(200);
    expect(res.body.preview).toMatchObject({ as: { userId: 'mina', role: 'member', org: 'orum', plan: 'free', status: 'active' }, env: 'dev', version: { label: 'v4' } });
    expect(res.body.preview.collections.map((c: { collection: string }) => c.collection)).toEqual(['projects', 'tickets', 'comments']);

    const tickets = collection(res.body, 'tickets');
    expect(tickets).toMatchObject({
      label: 'Tickets',
      ownerField: 'assignee_id',
      read: { scope: 'mine_shared', allowed: true, count: 2 },
      create: { scope: 'all', allowed: true },
      update: { scope: 'mine', allowed: true, count: 1 },
      delete: { scope: 'none', allowed: false, count: 0 },
    });
    expect(tickets.rows).toEqual([
      { id: T.danielShared, label: 'Daniel shared', ownerId: 'daniel', createdBy: 'daniel', shared: true, canUpdate: false, canDelete: false },
      { id: T.minaPrivate, label: 'Mina private', ownerId: 'mina', createdBy: 'jiwoo', shared: false, canUpdate: true, canDelete: false },
    ]);
    expect(collection(res.body, 'comments')).toMatchObject({ read: { count: 2 }, update: { count: 1 }, delete: { scope: 'mine', count: 1 } });
    expect(collection(res.body, 'projects')).toMatchObject({ read: { count: 1 }, create: { allowed: false }, update: { count: 0 } });
  });

  it('follows the member’s role and org', async () => {
    const admin = collection((await preview('jiwoo')).body, 'tickets');
    expect(admin).toMatchObject({ read: { scope: 'all', count: 3 }, update: { count: 3 }, delete: { allowed: true, count: 3 } });
    expect(admin.rows.every((r: { canDelete: boolean }) => r.canDelete)).toBe(true);

    const guest = collection((await preview('gina')).body, 'tickets');
    expect(guest).toMatchObject({ read: { count: 1 }, create: { allowed: false }, update: { allowed: false, count: 0 } });

    const otherOrg = collection((await preview('zed')).body, 'tickets');
    expect(otherOrg.rows.map((r: { id: string }) => r.id)).toEqual([T.acme]);
  });

  it('leaves the app data untouched', async () => {
    const state = async () => (await boardSql(`SELECT count(*)::int AS n, max(updated_at) AS touched FROM app.tickets`)).rows[0];
    const before = await state();
    await preview('jiwoo');
    await preview('mina');
    expect(await state()).toEqual(before);
    expect(before.n).toBe(4);
  });

  it('answers for unknown members, other builders and apps without a database', async () => {
    expect((await preview('nobody')).body).toMatchObject({ error: { code: 'not_found' } });
    expect((await preview('mina', await h.builder('stranger'))).status).toBe(403);
    expect((await h.req('POST', `/v1/apps/${APP}/policy/preview`, { token: builder, body: {} })).status).toBe(400);

    const prod = await h.req('POST', `/v1/apps/${APP}/policy/preview`, { token: builder, body: { as: 'mina', env: 'prod' } });
    expect(prod.body).toMatchObject({ error: { code: 'not_found' } });

    // A database that was never migrated to the version's schema.
    await h.req('PUT', '/internal/v1/apps/team-wiki/members/mina', { caller: await h.service('identity'), body: { org: 'orum' } });
    const wiki = await h.appDatabase('team-wiki', builder);
    await wiki.sql('DROP TABLE app.comments');
    const mismatch = await h.req('POST', '/v1/apps/team-wiki/policy/preview', { token: builder, body: { as: 'mina' } });
    expect(mismatch.body).toMatchObject({ error: { code: 'conflict' } });
  });
});
