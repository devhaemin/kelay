import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { audienceForApp, type AppRegistry, type CallerClaims } from '@kelay/contracts';
import { loadAppRegistry } from '@kelay/contracts/registry';
import { createDevSigner, signCallerToken, type DevSigner } from '@kelay/tokens';
import { createApp, createDatabases, type Databases } from '../src/app.ts';

const databaseUrl = inject('databaseUrl');
const SECRET = 'data-api-test-caller-secret-0123456789';
const APP = 'ticket-board';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3, T4, T5] = [1, 2, 3, 4, 5].map(id) as [string, string, string, string, string];
const P1 = id(101);
const C1 = id(201);

interface User {
  sub: string;
  org: string;
  role: string;
}
const alice: User = { sub: 'alice', org: 'orum', role: 'member' };
const bob: User = { sub: 'bob', org: 'orum', role: 'member' };
const gina: User = { sub: 'gina', org: 'orum', role: 'guest' };
const adam: User = { sub: 'adam', org: 'orum', role: 'admin' };
const olga: User = { sub: 'olga', org: 'other', role: 'admin' };

type Row = Record<string, unknown>;
interface Reply {
  status: number;
  body: { rows: Row[]; count: number; error?: { code: string; message: string } };
}

let signer: DevSigner;
let api: ReturnType<typeof createApp>;
let databases: Databases;
let superuser: pg.Client;
const logLines: Row[] = [];

async function seed(): Promise<void> {
  await superuser.query('TRUNCATE app.comments, app.tickets, app.projects');
  await superuser.query(`INSERT INTO app.projects (id, org_id, owner_id, name) VALUES ($1, 'orum', 'adam', 'Launch')`, [P1]);
  await superuser.query(
    `INSERT INTO app.tickets (id, org_id, owner_id, title, status, assignee_id, shared, due_on, project_id) VALUES
      ($1, 'orum',  'adam', 'Fix login',       'todo',   'alice', false, '2026-11-01T00:00:00Z', $6),
      ($2, 'orum',  'adam', 'Write docs',      'doing',  'bob',   false, '2026-11-20T00:00:00Z', $6),
      ($3, 'orum',  'bob',  'Fix billing',     'review', 'bob',   true,  '2026-12-01T00:00:00Z', NULL),
      ($4, 'orum',  'adam', 'Plan offsite',    'todo',   NULL,    false, NULL,                   NULL),
      ($5, 'other', 'olga', 'Other org plans', 'todo',   'alice', true,  NULL,                   NULL)`,
    [T1, T2, T3, T4, T5, P1],
  );
  await superuser.query(`INSERT INTO app.comments (id, org_id, owner_id, ticket_id, body) VALUES ($1, 'orum', 'bob', $2, 'On it')`, [
    C1,
    T3,
  ]);
}

const userToken = (u: User, app = APP, exp?: number) =>
  signer.sign({ ...u, app, plan: 'free', aud: audienceForApp(app), ...(exp ? { exp } : {}) });
const callerToken = (claims: CallerClaims, secret = SECRET) => signCallerToken(claims, secret);

interface CallOptions {
  as?: User;
  /** Raw authorization token; `null` sends no authorization header. */
  token?: string | null;
  /** Raw caller token; `null` sends no caller header. Defaults to this app's runtime. */
  caller?: string | null;
  app?: string;
}

async function call(body: unknown, opts: CallOptions = {}): Promise<Reply> {
  const app = opts.app ?? APP;
  const headers = new Headers({ 'content-type': 'application/json' });
  const token = opts.token === undefined ? await userToken(opts.as ?? alice, app) : opts.token;
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  const caller = opts.caller === undefined ? await callerToken({ kind: 'app-runtime', app, env: 'dev' }) : opts.caller;
  if (caller !== null) headers.set('x-kelay-caller', caller);
  const res = await api.request(`/v1/apps/${app}/query`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Reply['body'] };
}

const ids = (r: Reply) => r.body.rows.map((row) => row.id as string).sort();
const ticket = async (ticketId: string) => (await superuser.query('SELECT * FROM app.tickets WHERE id = $1', [ticketId])).rows[0];
const selectTickets = (extra: Row = {}) => ({ op: 'select', collection: 'tickets', ...extra });

beforeAll(async () => {
  signer = await createDevSigner();
  const require = createRequire(import.meta.url);
  const fixture = loadAppRegistry(require.resolve('@kelay/contracts/fixtures/apps.local.json'));
  const board = fixture.apps[APP]!;
  const registry: AppRegistry = {
    apps: {
      [APP]: { ...board, databaseUrl },
      'ghost-board': {
        handle: 'orum',
        databaseUrl,
        schema: { app: 'ghost-board', roles: ['admin'], collections: [{ name: 'ghosts', fields: { name: { type: 'text' } } }] },
      },
      'offline-board': {
        ...board,
        schema: { ...board.schema, app: 'offline-board' },
        databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none',
      },
    },
  };
  databases = createDatabases();
  const sink = new Writable({
    write(chunk, _encoding, done) {
      logLines.push(JSON.parse(String(chunk)) as Row);
      done();
    },
  });
  api = createApp({ jwks: signer.verifier, issuer: signer.issuer, callerSecret: SECRET, registry, databases, logger: pino(sink) });
  superuser = new pg.Client({ connectionString: databaseUrl });
  await superuser.connect();
});

afterAll(async () => {
  await databases?.close();
  await superuser?.end();
});

beforeEach(seed);

describe('reads under RLS', () => {
  it('shows a member their own tickets and shared ones only', async () => {
    const r = await call(selectTickets(), { as: alice });
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([T1, T3]);
    expect(r.body.count).toBe(2);
  });

  it('shows a guest shared tickets only', async () => {
    expect(ids(await call(selectTickets(), { as: gina }))).toEqual([T3]);
  });

  it('shows an admin every ticket in their org', async () => {
    expect(ids(await call(selectTickets(), { as: adam }))).toEqual([T1, T2, T3, T4]);
  });

  it('keeps other orgs invisible, even rows that name the same user', async () => {
    expect(ids(await call(selectTickets(), { as: olga }))).toEqual([T5]);
    const r = await call(selectTickets({ where: { id: T5 } }), { as: { ...alice, role: 'admin' } });
    expect(r.body.rows).toEqual([]);
  });

  it('returns typed columns', async () => {
    const [row] = (await call(selectTickets({ where: { id: T1 } }), { as: alice })).body.rows;
    expect(row).toMatchObject({ id: T1, org_id: 'orum', title: 'Fix login', shared: false, due_on: '2026-11-01T00:00:00.000Z' });
  });

  it('accepts service callers', async () => {
    const caller = await callerToken({ kind: 'service', svc: 'mcp-gateway' });
    expect((await call(selectTickets(), { as: alice, caller })).status).toBe(200);
  });
});

describe('writes under RLS', () => {
  it('lets a member insert, with owner_id and org_id from the token', async () => {
    const r = await call(
      { op: 'insert', collection: 'tickets', values: { title: 'New one', status: 'todo', assignee_id: 'alice' } },
      { as: alice },
    );
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
    expect(r.body.rows[0]).toMatchObject({ owner_id: 'alice', org_id: 'orum', title: 'New one', shared: false });
  });

  it('inserts a batch, defaulting columns a row leaves out', async () => {
    const r = await call(
      {
        op: 'insert',
        collection: 'tickets',
        values: [
          { title: 'A', status: 'todo', assignee_id: 'alice' },
          { title: 'B', status: 'todo', shared: true, due_on: '2026-12-24T09:00:00Z' },
        ],
      },
      { as: alice },
    );
    expect(r.status).toBe(200);
    expect(r.body.rows.map((row) => [row.title, row.shared, row.due_on])).toEqual([
      ['A', false, null],
      ['B', true, '2026-12-24T09:00:00.000Z'],
    ]);
  });

  it('denies a guest insert', async () => {
    const r = await call({ op: 'insert', collection: 'tickets', values: { title: 'Nope', status: 'todo' } }, { as: gina });
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe('denied');
    expect((await superuser.query('SELECT count(*)::int AS n FROM app.tickets')).rows[0].n).toBe(5);
  });

  it("denies a member updating someone else's ticket they can see", async () => {
    const r = await call({ op: 'update', collection: 'tickets', where: { id: T3 }, values: { status: 'done' } }, { as: alice });
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe('denied');
    expect((await ticket(T3)).status).toBe('review');
  });

  it('reports nothing matched when the ticket is invisible', async () => {
    const r = await call({ op: 'update', collection: 'tickets', where: { id: T2 }, values: { status: 'done' } }, { as: alice });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ rows: [], count: 0 });
    expect((await ticket(T2)).status).toBe('doing');
  });

  it("updates a member's own ticket and bumps updated_at", async () => {
    const before = await ticket(T1);
    const r = await call({ op: 'update', collection: 'tickets', where: { id: T1 }, values: { status: 'done' } }, { as: alice });
    expect(r.status).toBe(200);
    expect(r.body.rows[0]).toMatchObject({ id: T1, status: 'done' });
    expect((await ticket(T1)).updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('denies a member handing their ticket to someone else (WITH CHECK)', async () => {
    const r = await call({ op: 'update', collection: 'tickets', where: { id: T1 }, values: { assignee_id: 'bob' } }, { as: alice });
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe('denied');
    expect((await ticket(T1)).assignee_id).toBe('alice');
  });

  it('denies a member deleting a ticket, and lets an admin delete one', async () => {
    const denied = await call({ op: 'delete', collection: 'tickets', where: { id: T1 } }, { as: alice });
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('denied');
    const done = await call({ op: 'delete', collection: 'tickets', where: { id: T4 } }, { as: adam });
    expect(done.status).toBe(200);
    expect(ids(done)).toEqual([T4]);
    expect(await ticket(T4)).toBeUndefined();
  });

  it('maps a missing required field and a dangling reference to invalid_request', async () => {
    const missing = await call({ op: 'insert', collection: 'tickets', values: { status: 'todo' } }, { as: adam });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toEqual({ code: 'invalid_request', message: 'field "title" is required' });
    const dangling = await call(
      { op: 'insert', collection: 'tickets', values: { title: 'x', status: 'todo', project_id: id(999) } },
      { as: adam },
    );
    expect(dangling.status).toBe(400);
  });
});

describe('authentication', () => {
  it.each([
    ['no token', null],
    ['a malformed token', 'not-a-jwt'],
  ])('rejects %s with 401', async (_name, token) => {
    const r = await call(selectTickets(), { token });
    expect(r.status).toBe(401);
    expect(r.body.error?.code).toBe('unauthenticated');
  });

  it('rejects an expired token with 401', async () => {
    const token = await userToken(alice, APP, Math.floor(Date.now() / 1000) - 60);
    expect((await call(selectTickets(), { token })).status).toBe(401);
  });

  it('rejects a token from another signer with 401', async () => {
    const stranger = await createDevSigner(signer.issuer);
    const token = await stranger.sign({ ...alice, app: APP, plan: 'free', aud: audienceForApp(APP) });
    expect((await call(selectTickets(), { token })).status).toBe(401);
  });

  it('rejects a token for another app with 401', async () => {
    const r = await call(selectTickets(), { token: await userToken(alice, 'wiki') });
    expect(r.status).toBe(401);
    expect(r.body.error?.code).toBe('unauthenticated');
  });

  it('rejects a missing or forged caller token with 403', async () => {
    for (const caller of [null, await callerToken({ kind: 'app-runtime', app: APP }, 'z'.repeat(40))]) {
      const r = await call(selectTickets(), { caller });
      expect(r.status).toBe(403);
      expect(r.body.error?.code).toBe('forbidden_caller');
    }
  });

  it("rejects another app's runtime with 403", async () => {
    const r = await call(selectTickets(), { caller: await callerToken({ kind: 'app-runtime', app: 'wiki', env: 'dev' }) });
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe('forbidden_caller');
  });
});

describe('validation', () => {
  it('returns 404 for an unknown collection', async () => {
    const r = await call({ op: 'select', collection: 'invoices' });
    expect(r.status).toBe(404);
    expect(r.body.error?.code).toBe('unknown_collection');
  });

  it('returns 404 for an app the registry does not know', async () => {
    const r = await call(selectTickets(), { app: 'wiki' });
    expect(r.status).toBe(404);
    expect(r.body.error?.code).toBe('unknown_app');
  });

  it.each([
    ['where', selectTickets({ where: { priority: 1 } })],
    ['orderBy', selectTickets({ orderBy: [{ field: 'priority' }] })],
    ['values', { op: 'insert', collection: 'tickets', values: { title: 'x', status: 'todo', priority: 1 } }],
    ['a prototype key', selectTickets({ where: { constructor: 'x' } })],
    ['shared on a collection without it', { op: 'insert', collection: 'comments', values: { ticket_id: T1, body: 'x', shared: true } }],
  ])('rejects an unknown field in %s', async (_place, body) => {
    const r = await call(body, { as: adam });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('invalid_request');
  });

  it.each(['id', 'org_id', 'owner_id', 'created_at', 'updated_at'])('rejects writes to %s', async (field) => {
    const value = field.endsWith('_at') ? '2026-01-01T00:00:00Z' : field === 'id' ? id(77) : 'someone';
    const insert = await call({ op: 'insert', collection: 'tickets', values: { title: 'x', status: 'todo', [field]: value } }, { as: adam });
    expect(insert.status).toBe(400);
    const update = await call({ op: 'update', collection: 'tickets', where: { id: T1 }, values: { [field]: value } }, { as: adam });
    expect(update.status).toBe(400);
  });

  it('allows filtering on reserved columns', async () => {
    const r = await call(selectTickets({ where: { owner_id: 'bob', org_id: 'orum' } }), { as: adam });
    expect(ids(r)).toEqual([T3]);
  });

  it.each([
    ['a number for a text field', { op: 'insert', collection: 'tickets', values: { title: 5, status: 'todo' } }],
    ['a number for a timestamp filter', selectTickets({ where: { due_on: { gt: 5 } } })],
    ['a malformed uuid', selectTickets({ where: { id: 'not-a-uuid' } })],
    ['a malformed timestamp', selectTickets({ where: { due_on: { gt: 'someday' } } })],
    ['like on a uuid field', selectTickets({ where: { id: { like: '0%' } } })],
    ['gt with null', selectTickets({ where: { due_on: { gt: null } } })],
    ['an empty condition', selectTickets({ where: { status: {} } })],
    ['an unknown op', { op: 'upsert', collection: 'tickets' }],
    ['a limit over 500', selectTickets({ limit: 501 })],
    ['an update without where', { op: 'update', collection: 'tickets', where: {}, values: { status: 'done' } }],
    ['an update without values', { op: 'update', collection: 'tickets', where: { id: T1 }, values: {} }],
    ['a delete without where', { op: 'delete', collection: 'tickets', where: {} }],
  ])('rejects %s with 400', async (_name, body) => {
    const r = await call(body, { as: adam });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('invalid_request');
  });

  it('rejects a body that is not JSON', async () => {
    const r = await call('{"op": "select",', { as: adam });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('invalid_request');
  });
});

describe('injection attempts', () => {
  it.each([
    ['collection', { op: 'select', collection: 'tickets; DROP TABLE app.tickets' }],
    ['collection quoting', { op: 'select', collection: 'tickets" --' }],
    ['where field', selectTickets({ where: { 'title" = title OR "1': 'x' } })],
    ['orderBy field', selectTickets({ orderBy: [{ field: 'title; DROP TABLE app.tickets' }] })],
    ['values field', { op: 'insert', collection: 'tickets', values: { 'title") VALUES (1); --': 'x' } }],
    ['schema-qualified collection', { op: 'select', collection: 'pg_catalog.pg_roles' }],
  ])('rejects SQL in a %s name', async (_place, body) => {
    const r = await call(body, { as: adam });
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('invalid_request');
  });

  it('treats SQL in values as data', async () => {
    const r = await call(selectTickets({ where: { title: "x' OR '1'='1" } }), { as: adam });
    expect(r.body.rows).toEqual([]);
    const evil = "'); DROP TABLE app.tickets; --";
    const inserted = await call({ op: 'insert', collection: 'tickets', values: { title: evil, status: 'todo' } }, { as: adam });
    expect(inserted.body.rows[0]?.title).toBe(evil);
    expect((await superuser.query('SELECT count(*)::int AS n FROM app.tickets')).rows[0].n).toBe(6);
  });
});

describe('where operators and paging', () => {
  it.each([
    ['in', { status: { in: ['todo', 'review'] } }, [T1, T3, T4]],
    ['in with null', { assignee_id: { in: [null, 'alice'] } }, [T1, T4]],
    ['empty in', { status: { in: [] } }, []],
    ['gt', { due_on: { gt: '2026-11-10T00:00:00Z' } }, [T2, T3]],
    ['gte and lt', { due_on: { gte: '2026-11-01T00:00:00Z', lt: '2026-12-01T00:00:00Z' } }, [T1, T2]],
    ['like', { title: { like: 'Fix%' } }, [T1, T3]],
    ['ne keeps nulls', { assignee_id: { ne: 'bob' } }, [T1, T4]],
    ['equality with null', { assignee_id: null }, [T4]],
    ['ne null', { due_on: { ne: null }, shared: false }, [T1, T2]],
  ])('filters with %s', async (_name, where, expected) => {
    const r = await call(selectTickets({ where }), { as: adam });
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([...expected].sort());
  });

  it('orders, limits and offsets', async () => {
    const asc = await call(selectTickets({ orderBy: [{ field: 'title' }], limit: 2, offset: 1 }), { as: adam });
    expect(asc.body.rows.map((row) => row.title)).toEqual(['Fix login', 'Plan offsite']);
    const desc = await call(selectTickets({ orderBy: [{ field: 'title', dir: 'desc' }], limit: 2 }), { as: adam });
    expect(desc.body.rows.map((row) => row.title)).toEqual(['Write docs', 'Plan offsite']);
  });

  it('applies the same filters inside RLS', async () => {
    const r = await call(selectTickets({ where: { title: { like: 'Fix%' } } }), { as: gina });
    expect(ids(r)).toEqual([T3]);
  });
});

describe('failures and logs', () => {
  it('hides database details behind internal errors', async () => {
    for (const app of ['ghost-board', 'offline-board']) {
      const collection = app === 'ghost-board' ? 'ghosts' : 'tickets';
      const r = await call({ op: 'select', collection }, { as: adam, app });
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ error: { code: 'internal', message: 'internal error' } });
    }
  });

  it('writes one structured line per request', async () => {
    logLines.length = 0;
    await call(selectTickets(), { as: alice });
    await call({ op: 'update', collection: 'tickets', where: { id: T3 }, values: { status: 'done' } }, { as: alice });
    expect(logLines).toHaveLength(2);
    expect(logLines[0]).toMatchObject({
      type: 'data_query',
      app: APP,
      op: 'select',
      collection: 'tickets',
      status: 200,
      sub: 'alice',
      caller: `app-runtime:${APP}`,
      count: 2,
    });
    expect(typeof logLines[0]?.ms).toBe('number');
    expect(logLines[1]).toMatchObject({ op: 'update', status: 403, code: 'denied', sub: 'alice' });
  });

  it('answers health checks', async () => {
    const res = await api.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
