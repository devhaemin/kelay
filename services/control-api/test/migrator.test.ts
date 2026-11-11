import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { databaseUrlWithCredentials } from '@kelay/contracts';
import { createAppDatabases } from '../src/appdb.ts';
import { PgAppDatabaseMigrator } from '../src/deploy/migrator.ts';
import { ADMIN_URL } from './global-setup.ts';
import { ticketBoardPolicy, ticketBoardSchema } from './harness.ts';

const admin = new URL(ADMIN_URL);
const credentials = { user: decodeURIComponent(admin.username), password: decodeURIComponent(admin.password) };
/** The URL of a database on the test server as production stores it: no user, no password. */
const bareUrl = (name: string) => `postgres://${admin.host}/${name}`;
const created: string[] = [];
const freshName = () => {
  const name = `app_created_${randomBytes(6).toString('hex')}`;
  created.push(name);
  return name;
};

async function onServer<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
const exists = (name: string) => onServer(async (c) => (await c.query('select 1 from pg_database where datname = $1', [name])).rowCount === 1);

afterAll(async () => {
  await onServer(async (c) => {
    for (const name of created) await c.query(`drop database if exists ${name} with (force)`);
  });
});

describe('app database migrator', () => {
  const input = (databaseUrl: string) => ({ app: 'ticket-board', env: 'dev' as const, databaseUrl, schema: ticketBoardSchema, policy: ticketBoardPolicy });

  it('creates the database of an env on its first deploy, logging in with DB_USER and DB_PASSWORD', async () => {
    const name = freshName();
    expect(await exists(name)).toBe(false);
    const migrator = new PgAppDatabaseMigrator({ credentials });
    await migrator.migrate(input(bareUrl(name)));
    expect(await exists(name)).toBe(true);

    // The same URL and login reach the tables the migration made, and a second deploy changes nothing.
    await migrator.migrate(input(bareUrl(name)));
    const dbs = createAppDatabases({ credentials });
    try {
      const tables = await dbs.pool(bareUrl(name)).query(`select table_name from information_schema.tables where table_schema = 'app' order by 1`);
      expect(tables.rows.map((r) => r.table_name)).toEqual(ticketBoardSchema.collections.map((c: { name: string }) => c.name).sort());
    } finally {
      await dbs.close();
    }
  });

  it('refuses a database name that is not a plain identifier, and reports other connection failures as they are', async () => {
    const migrator = new PgAppDatabaseMigrator({ credentials });
    await expect(migrator.migrate(input(bareUrl('App-Board%3B')))).rejects.toThrow(/refusing to create a database/);
    await expect(new PgAppDatabaseMigrator({ credentials: { user: credentials.user, password: 'wrong' } }).migrate(input(bareUrl(freshName())))).rejects.toThrow(/password authentication failed/);
    await expect(new PgAppDatabaseMigrator({ connectionTimeoutMillis: 500 }).migrate(input('postgres://nobody:nothing@127.0.0.1:1/none'))).rejects.toThrow();
  });
});

describe('databaseUrlWithCredentials', () => {
  it('adds the login only to a URL without one, and encodes it', () => {
    expect(databaseUrlWithCredentials('postgres://proxy.internal:5432/app_x_dev?sslmode=require', { user: 'kelay_platform', password: 'p@ss/w:rd' })).toBe(
      'postgres://kelay_platform:p%40ss%2Fw%3Ard@proxy.internal:5432/app_x_dev?sslmode=require',
    );
    const own = 'postgres://kelay:kelay@localhost:54320/app_x_dev';
    expect(databaseUrlWithCredentials(own, { user: 'other', password: 'x' })).toBe(own);
    expect(databaseUrlWithCredentials(own, undefined)).toBe(own);
    expect(databaseUrlWithCredentials('postgres://proxy/app', {})).toBe('postgres://proxy/app');
  });
});
