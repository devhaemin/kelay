// App database access (contract §3): one lazily created pool per database URL, and every
// query runs in a transaction that carries the verified claims as `kelay_runtime`.
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool } from 'pg';
import { RUNTIME_DB_ROLE, databaseUrlWithCredentials, type DatabaseCredentials, type KelayClaims } from '@kelay/contracts';

export type AppDb = Kysely<any>;

/** The connection or the claims setup failed. Never the client's fault, whatever the SQLSTATE. */
export class DbSetupError extends Error {
  constructor(cause: unknown) {
    super(`database setup failed: ${(cause as Error)?.message ?? String(cause)}`, { cause });
    this.name = 'DbSetupError';
  }
}

export interface Databases {
  get(databaseUrl: string): AppDb;
  close(): Promise<void>;
}

export interface DatabasesOptions {
  poolMax?: number;
  /** Login for app database URLs that carry none (DB_USER, DB_PASSWORD). */
  credentials?: DatabaseCredentials;
  onPoolError?: (err: Error) => void;
}

export function createDatabases(opts: DatabasesOptions = {}): Databases {
  const dbs = new Map<string, AppDb>();
  return {
    get(databaseUrl) {
      let db = dbs.get(databaseUrl);
      if (!db) {
        const pool = new Pool({ connectionString: databaseUrlWithCredentials(databaseUrl, opts.credentials), max: opts.poolMax ?? 10 });
        // Without a listener, an idle client's network error crashes the process.
        pool.on('error', (err) => opts.onPoolError?.(err));
        db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
        dbs.set(databaseUrl, db);
      }
      return db;
    },
    async close() {
      const all = [...dbs.values()];
      dbs.clear();
      await Promise.all(all.map((db) => db.destroy()));
    },
  };
}

export async function asUser<T>(db: AppDb, claims: KelayClaims, fn: (trx: Transaction<any>) => Promise<T>): Promise<T> {
  let ready = false;
  try {
    return await db.transaction().execute(async (trx) => {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`.execute(trx);
      await sql`set local role ${sql.id(RUNTIME_DB_ROLE)}`.execute(trx);
      ready = true;
      return fn(trx);
    });
  } catch (e) {
    throw ready ? e : new DbSetupError(e);
  }
}
