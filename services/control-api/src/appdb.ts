// Read-only probes of an app database (contract §3). The control API never changes app data: every
// probe runs in a transaction that is rolled back, with the same claims setup the Data API uses.
import pg from 'pg';
import { APP_DB_SCHEMA, RUNTIME_DB_ROLE, type KelayClaims } from '@kelay/contracts';
import { quoteIdent } from '@kelay/policy';

export interface AppDatabases {
  /** One lazily created pool per database URL. */
  pool(databaseUrl: string): pg.Pool;
  close(): Promise<void>;
}

export function createAppDatabases(opts: { poolMax?: number; onPoolError?: (err: Error) => void } = {}): AppDatabases {
  const pools = new Map<string, pg.Pool>();
  return {
    pool(databaseUrl) {
      let pool = pools.get(databaseUrl);
      if (!pool) {
        pool = new pg.Pool({ connectionString: databaseUrl, max: opts.poolMax ?? 3, connectionTimeoutMillis: 5000 });
        // Without a listener, an idle client's network error crashes the process.
        pool.on('error', (err) => opts.onPoolError?.(err));
        pools.set(databaseUrl, pool);
      }
      return pool;
    },
    async close() {
      const all = [...pools.values()];
      pools.clear();
      await Promise.all(all.map((p) => p.end()));
    },
  };
}

export const appTable = (collection: string): string => `${quoteIdent(APP_DB_SCHEMA)}.${quoteIdent(collection)}`;

export type ProbeClaims = Pick<KelayClaims, 'sub' | 'app' | 'org' | 'role' | 'plan'>;

/** Runs `fn` inside a transaction and always rolls it back. */
export async function rolledBack<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let rollbackError: Error | undefined;
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch((e: Error) => {
      rollbackError = e;
    });
    // A connection whose rollback failed may still hold the claims and the role, so it is destroyed.
    client.release(rollbackError);
  }
}

/** From here to the end of the transaction, queries run as this user would through the Data API. */
export async function actAs(client: pg.PoolClient, claims: ProbeClaims): Promise<void> {
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
  await client.query(`SET LOCAL ROLE ${quoteIdent(RUNTIME_DB_ROLE)}`);
}

const SAVEPOINT = 'kelay_probe';

/** Runs one statement group and undoes it, so a failed statement does not abort the surrounding transaction. */
export async function probe<T>(client: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    return await fn();
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
  }
}

export const isDatabaseError = (e: unknown): e is pg.DatabaseError => e instanceof pg.DatabaseError;

/** SQLSTATE 42501: RLS or a missing privilege refused the statement. */
export const isPermissionDenied = (e: unknown): boolean => isDatabaseError(e) && e.code === '42501';

/** The database does not have the tables or columns this schema version declares. */
export const isSchemaMismatch = (e: unknown): boolean => isDatabaseError(e) && ['42P01', '42703', '3F000', '42883'].includes(e.code ?? '');
