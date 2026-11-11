// Brings an app database to a version's schema and access rules (contracts §2–§3). Deploy and publish
// call this before the version goes live, so the rules a version records are the rules Postgres enforces.
import pg from 'pg';
import { databaseUrlWithCredentials, type AppSchema, type DatabaseCredentials, type PolicyMatrix } from '@kelay/contracts';
import { migrationSql, quoteIdent } from '@kelay/policy';
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

export interface PgAppDatabaseMigratorOptions {
  connectionTimeoutMillis?: number;
  /** Login for database URLs that carry none (DB_USER, DB_PASSWORD). */
  credentials?: DatabaseCredentials;
}

/** SQLSTATE 3D000: the server is there, the database is not. */
const NO_SUCH_DATABASE = '3D000';
/** SQLSTATE 42P04: another deploy created the database first. */
const DUPLICATE_DATABASE = '42P04';
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Runs `migrationSql` over a connection of its own, as the login role of the database URL (or of
 * `credentials`). That is the role the Data API connects with, which the migration grants
 * `kelay_runtime` to (contract §3). An env's database is created the first time a version is
 * deployed to it, so the login role needs CREATEDB.
 */
export class PgAppDatabaseMigrator implements AppDatabaseMigrator {
  constructor(private readonly opts: PgAppDatabaseMigratorOptions = {}) {}

  async migrate(input: AppMigrationInput): Promise<void> {
    const sql = migrationSql(input.schema, input.policy ?? {});
    const url = databaseUrlWithCredentials(input.databaseUrl, this.opts.credentials);
    const client = await this.connect(url).catch(async (e: unknown) => {
      if ((e as pg.DatabaseError)?.code !== NO_SUCH_DATABASE) throw e;
      await this.createDatabase(url);
      return this.connect(url);
    });
    try {
      // One query string is one implicit transaction: the rules are replaced completely or not at all.
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  private async connect(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: this.opts.connectionTimeoutMillis ?? 5000 });
    try {
      await client.connect();
    } catch (e) {
      await client.end().catch(() => {});
      throw e;
    }
    return client;
  }

  private async createDatabase(url: string): Promise<void> {
    const maintenance = new URL(url);
    const name = decodeURIComponent(maintenance.pathname.slice(1));
    if (!DATABASE_NAME.test(name)) throw new Error(`refusing to create a database named ${JSON.stringify(name)}`);
    maintenance.pathname = '/postgres';
    const client = await this.connect(maintenance.toString());
    try {
      await client.query(`CREATE DATABASE ${quoteIdent(name)}`);
    } catch (e) {
      if ((e as pg.DatabaseError)?.code !== DUPLICATE_DATABASE) throw e;
    } finally {
      await client.end();
    }
  }
}
