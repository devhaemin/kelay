// Brings the control DB and the ticket-board app DB to the current schema. Safe to re-run.
import pg from 'pg';
import { loadAppRegistry } from '@kelay/contracts/registry';
import { RUNTIME_DB_ROLE } from '@kelay/contracts';
import { createDatabase, runMigrations } from '@kelay/control-api';
import { migrateIdentity, type IdentityDeps } from '@kelay/identity';
import { migrationSql } from '@kelay/policy';
import { TICKET_BOARD, type StackConfig } from './config.ts';

export function identityDeps(cfg: StackConfig, database: pg.Pool): IdentityDeps {
  return {
    database,
    issuer: cfg.issuer,
    secret: cfg.authSecret,
    registry: loadAppRegistry(cfg.appsFile),
    mcpPublicBaseUrl: cfg.mcpPublicBaseUrl,
  };
}

export async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates the database named in `url` when the server does not have it yet. */
async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`refusing to create database ${JSON.stringify(name)}`);
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  await withClient(maintenance.toString(), async (client) => {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (!rowCount) await client.query(`create database ${name}`);
  });
}

export async function migrate(cfg: StackConfig): Promise<void> {
  await ensureDatabase(cfg.controlDatabaseUrl);
  await ensureDatabase(cfg.appDatabaseUrl);

  // Control API first: it owns app_members, which Kelay ID reads (contract §9).
  const control = createDatabase(cfg.controlDatabaseUrl, { max: 1 });
  try {
    await runMigrations(control.db);
  } finally {
    await control.close();
  }

  const pool = new pg.Pool({ connectionString: cfg.controlDatabaseUrl, max: 2 });
  try {
    await migrateIdentity(identityDeps(cfg, pool));
  } finally {
    await pool.end();
  }

  const board = loadAppRegistry(cfg.appsFile).apps[TICKET_BOARD]!;
  if (!board.policy) throw new Error(`${cfg.appsFile}: ${TICKET_BOARD} has no policy`);
  const sql = migrationSql(board.schema, board.policy);
  await withClient(cfg.appDatabaseUrl, async (client) => {
    await client.query(sql);
    // The Data API connects with this login role and runs every query after SET LOCAL ROLE (contract §3).
    await client.query(`grant ${RUNTIME_DB_ROLE} to current_user`);
  });
}
