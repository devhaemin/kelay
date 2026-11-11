// Applies the ticket-board migration to a disposable postgres:17 (contract §0, port 54331 per §11)
// and checks RLS by running queries the way the Data API does (contract §3, per-transaction setup).
// Set KELAY_POLICY_DATABASE_URL to use an existing throwaway database instead of Docker.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationSql } from './index.ts';

const fx = (p: string) =>
  JSON.parse(readFileSync(createRequire(import.meta.url).resolve(`@kelay/contracts/fixtures/${p}`), 'utf8'));
const schema = fx('ticket-board/schema.json');
const policy = fx('ticket-board/policy.json');

const CONTAINER = 'kelay-pg-policy';
const PORT = 54331;
const external = process.env.KELAY_POLICY_DATABASE_URL;
const url = external ?? `postgres://postgres:kelay@localhost:${PORT}/postgres`;
const canRun = external !== undefined || spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
if (!canRun) console.warn('rls.pg.test: Docker is not available and KELAY_POLICY_DATABASE_URL is unset; skipping');

const P = { orum: '00000000-0000-4000-8000-000000000001', acme: '00000000-0000-4000-8000-000000000002' };
const T = {
  alicePrivate: '00000000-0000-4000-8000-0000000000a1',
  bobPrivate: '00000000-0000-4000-8000-0000000000b1',
  bobShared: '00000000-0000-4000-8000-0000000000b2',
  unassigned: '00000000-0000-4000-8000-0000000000c1',
  acme: '00000000-0000-4000-8000-0000000000d1',
};

const claims = (sub: string, role: string, org = 'orum') => ({
  iss: 'http://localhost:4001',
  sub,
  aud: 'kelay:app:ticket-board',
  app: 'ticket-board',
  org,
  role,
  plan: 'free',
});
const alice = claims('alice', 'member');
const bob = claims('bob', 'member');
const gina = claims('gina', 'guest');
const adam = claims('adam', 'admin');
const zed = claims('zed', 'admin', 'acme');

let db: pg.Client;

async function connect(deadline: number): Promise<pg.Client> {
  for (;;) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      await c.query('SELECT 1');
      return c;
    } catch (e) {
      await c.end().catch(() => {});
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Runs `fn` as the Data API would for a verified user, then rolls back. */
async function as<T>(user: object, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(user)]);
    await db.query('SET LOCAL ROLE kelay_runtime');
    return await fn(db);
  } finally {
    await db.query('ROLLBACK');
  }
}

const ticketIds = (user: object) =>
  as(user, async (c) => (await c.query<{ id: string }>('SELECT id FROM app.tickets ORDER BY id')).rows.map((r) => r.id));

const kelayPolicies = async () =>
  (await db.query<{ name: string }>(`SELECT tablename || '.' || policyname AS name FROM pg_policies WHERE schemaname = 'app' ORDER BY 1`)).rows.map(
    (r) => r.name,
  );

describe.skipIf(!canRun)('ticket-board RLS on Postgres', () => {
  beforeAll(async () => {
    if (!external) {
      spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
      execFileSync('docker', ['run', '-d', '--rm', '--name', CONTAINER, '-p', `${PORT}:5432`, '-e', 'POSTGRES_PASSWORD=kelay', 'postgres:17'], {
        stdio: 'ignore',
      });
    }
    db = await connect(Date.now() + 60_000);
    await db.query(migrationSql(schema, policy));
    // Seeded as the superuser, which bypasses RLS, so org_id and owner_id are explicit.
    await db.query(
      `INSERT INTO app.projects (id, org_id, owner_id, name) VALUES ($1, 'orum', 'adam', 'Launch'), ($2, 'acme', 'zed', 'Elsewhere')`,
      [P.orum, P.acme],
    );
    await db.query(
      `INSERT INTO app.tickets (id, org_id, owner_id, title, status, assignee_id, shared, project_id) VALUES
        ($1, 'orum', 'adam',  'Alice private', 'todo',  'alice', false, $6),
        ($2, 'orum', 'adam',  'Bob private',   'todo',  'bob',   false, $6),
        ($3, 'orum', 'bob',   'Bob shared',    'doing', 'bob',   true,  $6),
        ($4, 'orum', 'alice', 'Unassigned',    'todo',  NULL,    false, NULL),
        ($5, 'acme', 'alice', 'Acme ticket',   'todo',  'alice', true,  $7)`,
      [T.alicePrivate, T.bobPrivate, T.bobShared, T.unassigned, T.acme, P.orum, P.acme],
    );
    await db.query(
      `INSERT INTO app.comments (org_id, owner_id, ticket_id, body) VALUES
        ('orum', 'alice', $1, 'mine'), ('orum', 'bob', $2, 'bobs'), ('acme', 'alice', $3, 'elsewhere')`,
      [T.alicePrivate, T.bobShared, T.acme],
    );
  }, 180_000);

  afterAll(async () => {
    await db?.end();
    if (!external) spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  });

  it('member sees tickets assigned to them plus shared tickets, judged by ownerField not owner_id', async () => {
    expect(await ticketIds(alice)).toEqual([T.alicePrivate, T.bobShared].sort());
    expect(await ticketIds(bob)).toEqual([T.bobPrivate, T.bobShared].sort());
  });

  it("member update of someone else's ticket affects 0 rows, even a shared one", async () => {
    await as(alice, async (c) => {
      expect((await c.query(`UPDATE app.tickets SET status = 'done' WHERE id = $1`, [T.bobPrivate])).rowCount).toBe(0);
      expect((await c.query(`UPDATE app.tickets SET status = 'done' WHERE id = $1`, [T.bobShared])).rowCount).toBe(0);
      expect((await c.query(`UPDATE app.tickets SET status = 'done' WHERE id = $1`, [T.alicePrivate])).rowCount).toBe(1);
    });
  });

  it('member cannot hand their ticket to someone else (WITH CHECK)', async () => {
    await expect(
      as(alice, (c) => c.query(`UPDATE app.tickets SET assignee_id = 'bob' WHERE id = $1`, [T.alicePrivate])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('member insert works, and owner_id and org_id default from the claims', async () => {
    const row = await as(alice, async (c) => {
      const res = await c.query(`INSERT INTO app.tickets (title, status, assignee_id) VALUES ('New', 'todo', 'alice') RETURNING *`);
      return res.rows[0];
    });
    expect(row).toMatchObject({ owner_id: 'alice', org_id: 'orum', shared: false, title: 'New' });
  });

  it('member insert of a row they cannot read succeeds, but fails with RETURNING (SELECT policy applies)', async () => {
    const insert = `INSERT INTO app.tickets (title, status, assignee_id) VALUES ('For bob', 'todo', 'bob')`;
    await as(alice, async (c) => expect((await c.query(insert)).rowCount).toBe(1));
    await expect(as(alice, (c) => c.query(`${insert} RETURNING *`))).rejects.toMatchObject({ code: '42501' });
  });

  it('member cannot insert into another org', async () => {
    await expect(
      as(alice, (c) => c.query(`INSERT INTO app.tickets (org_id, title, status) VALUES ('acme', 'Sneaky', 'todo')`)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('member delete of a ticket affects 0 rows (delete is none)', async () => {
    await as(alice, async (c) => {
      expect((await c.query('DELETE FROM app.tickets WHERE id = $1', [T.alicePrivate])).rowCount).toBe(0);
    });
  });

  it('guest ticket insert fails with SQLSTATE 42501, while guest comments are allowed', async () => {
    await expect(
      as(gina, (c) => c.query(`INSERT INTO app.tickets (title, status) VALUES ('Nope', 'todo')`)),
    ).rejects.toMatchObject({ code: '42501' });
    const owner = await as(gina, async (c) => {
      const res = await c.query<{ owner_id: string }>(`INSERT INTO app.comments (ticket_id, body) VALUES ($1, 'hi') RETURNING owner_id`, [T.bobShared]);
      return res.rows[0]?.owner_id;
    });
    expect(owner).toBe('gina');
    expect(await ticketIds(gina)).toEqual([T.bobShared]);
  });

  it('admin sees every ticket of their org and can delete', async () => {
    expect(await ticketIds(adam)).toEqual([T.alicePrivate, T.bobPrivate, T.bobShared, T.unassigned].sort());
    await as(adam, async (c) => {
      expect((await c.query('DELETE FROM app.comments')).rowCount).toBe(2);
    });
  });

  it('rows of another org are invisible to everyone', async () => {
    for (const user of [alice, bob, gina, adam]) {
      const seen = await as(user, async (c) => ({
        tickets: (await c.query('SELECT 1 FROM app.tickets WHERE org_id = $1', ['acme'])).rowCount,
        projects: (await c.query('SELECT 1 FROM app.projects WHERE id = $1', [P.acme])).rowCount,
        comments: (await c.query(`SELECT 1 FROM app.comments WHERE body = 'elsewhere'`)).rowCount,
        updated: (await c.query(`UPDATE app.tickets SET status = 'done' WHERE id = $1`, [T.acme])).rowCount,
      }));
      expect(seen).toEqual({ tickets: 0, projects: 0, comments: 0, updated: 0 });
    }
    expect(await ticketIds(zed)).toEqual([T.acme]);
  });

  it('sees nothing without claims or with a role the schema does not declare', async () => {
    expect(await ticketIds({})).toEqual([]);
    expect(await ticketIds(claims('mallory', 'owner'))).toEqual([]);
  });

  it('re-running migrationSql is idempotent and keeps data', async () => {
    const before = await kelayPolicies();
    expect(before).toHaveLength(25);
    await db.query(migrationSql(schema, policy));
    await db.query(migrationSql(schema, policy));
    expect(await kelayPolicies()).toEqual(before);
    expect((await db.query('SELECT 1 FROM app.tickets')).rowCount).toBe(5);
    expect(await ticketIds(alice)).toEqual([T.alicePrivate, T.bobShared].sort());
  });

  it('adds the column of a field introduced later and leaves existing rows alone', async () => {
    const withEstimate = {
      ...schema,
      collections: schema.collections.map((c: { name: string; fields: object }) =>
        c.name === 'tickets' ? { ...c, fields: { ...c.fields, estimate: { type: 'number', required: true } } } : c,
      ),
    };
    await db.query(migrationSql(withEstimate, policy));
    const rows = await db.query<{ estimate: number | null }>('SELECT estimate FROM app.tickets');
    expect(rows.rowCount).toBe(5);
    expect(rows.rows.every((r) => r.estimate === null)).toBe(true);
    await as(alice, (c) => c.query(`UPDATE app.tickets SET estimate = 3 WHERE id = $1`, [T.alicePrivate]));
  });

  it('sets updated_at on every update, whatever the writer sends', async () => {
    await as(alice, async (c) => {
      const before = await c.query<{ updated_at: Date }>(`SELECT updated_at FROM app.tickets WHERE id = $1`, [T.alicePrivate]);
      const after = await c.query<{ updated_at: Date; now: Date }>(
        `UPDATE app.tickets SET status = 'doing', updated_at = '2000-01-01' WHERE id = $1 RETURNING updated_at, now() AS now`,
        [T.alicePrivate],
      );
      expect(after.rows[0]!.updated_at).toEqual(after.rows[0]!.now);
      expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThan(before.rows[0]!.updated_at.getTime());
    });
  });

  it('lets a plain login role that ran the migration act as kelay_runtime', async () => {
    await db.query(`DROP ROLE IF EXISTS kelay_app_login`);
    await db.query(`CREATE ROLE kelay_app_login LOGIN PASSWORD 'kelay' CREATEROLE`);
    await db.query(`CREATE DATABASE kelay_login_test OWNER kelay_app_login`);
    const loginUrl = new URL(url);
    loginUrl.username = 'kelay_app_login';
    loginUrl.password = 'kelay';
    loginUrl.pathname = '/kelay_login_test';
    const login = new pg.Client({ connectionString: loginUrl.toString() });
    await login.connect();
    try {
      // kelay_runtime already exists in the cluster, so this role did not create it and holds no membership yet.
      await expect(login.query('SET ROLE kelay_runtime')).rejects.toMatchObject({ code: '42501' });
      await db.query('GRANT kelay_runtime TO kelay_app_login WITH ADMIN OPTION, SET FALSE, INHERIT FALSE');
      await login.query(migrationSql(schema, policy));
      await login.query(migrationSql(schema, policy));
      await login.query('BEGIN');
      await login.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(alice)]);
      await login.query('SET LOCAL ROLE kelay_runtime');
      expect((await login.query('SELECT 1 FROM app.tickets')).rowCount).toBe(0);
      await login.query('ROLLBACK');
    } finally {
      await login.end();
      await db.query('DROP DATABASE kelay_login_test WITH (FORCE)');
      await db.query('DROP OWNED BY kelay_app_login');
      await db.query('DROP ROLE kelay_app_login');
    }
  });

  it('drops policies of removed roles and keeps policies that do not follow the kelay pattern', async () => {
    await db.query(`CREATE POLICY "audit_read" ON app.tickets FOR SELECT TO kelay_runtime USING (false)`);
    const { guest: _removed, ...withoutGuest } = policy;
    await db.query(migrationSql({ ...schema, roles: ['admin', 'member'] }, withoutGuest));
    const names = await kelayPolicies();
    expect(names.filter((n) => n.endsWith('_guest'))).toEqual([]);
    expect(names).toContain('tickets.audit_read');
    expect(await ticketIds(gina)).toEqual([]);

    await db.query('DROP POLICY "audit_read" ON app.tickets');
    await db.query(migrationSql(schema, policy));
    expect(await ticketIds(gina)).toEqual([T.bobShared]);
  });
});
