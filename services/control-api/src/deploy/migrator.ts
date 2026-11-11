// Brings an app database to a version's schema and access rules (contracts §2–§3). Deploy and publish
// call this before the version goes live, so the rules a version records are the rules Postgres enforces.
import pg from 'pg';
import type { AppSchema, PolicyMatrix } from '@kelay/contracts';
import { migrationSql } from '@kelay/policy';
import type { EnvName } from '../db/schema.ts';

export interface AppMigrationInput {
  app: string;
  env: EnvName;
  /** The env's database, from the app registry (`envs.database_url`). */
  databaseUrl: string;
  schema: AppSchema;
  /** A version without rules gets none, so every row is denied (contract §3: a missing entry means `none`). */
  policy: PolicyMatrix | null;
}

export interface AppDatabaseMigrator {
  migrate(input: AppMigrationInput): Promise<void>;
}

/**
 * Runs `migrationSql` over a connection of its own, as the login role in the database URL. That is the
 * role the Data API connects with, which the migration grants `kelay_runtime` to (contract §3).
 */
export class PgAppDatabaseMigrator implements AppDatabaseMigrator {
  constructor(private readonly opts: { connectionTimeoutMillis?: number } = {}) {}

  async migrate(input: AppMigrationInput): Promise<void> {
    const sql = migrationSql(input.schema, input.policy ?? {});
    const client = new pg.Client({ connectionString: input.databaseUrl, connectionTimeoutMillis: this.opts.connectionTimeoutMillis ?? 5000 });
    await client.connect();
    try {
      // One query string is one implicit transaction: the rules are replaced completely or not at all.
      await client.query(sql);
    } finally {
      await client.end();
    }
  }
}
