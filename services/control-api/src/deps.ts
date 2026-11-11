import type { AppDatabases } from './appdb.ts';
import type { AuthConfig } from './auth.ts';
import type { Db } from './db/client.ts';
import type { DeployDriver } from './deploy/driver.ts';
import type { AppDatabaseMigrator } from './deploy/migrator.ts';
import type { Llm } from './llm/types.ts';
import type { Logger } from './log.ts';
import type { QaRunner } from './qa/runner.ts';
import type { ImprovementQueue } from './queue/improvement.ts';

export interface ControlApiDeps {
  db: Db;
  auth: AuthConfig;
  llm: Llm;
  deploy: DeployDriver;
  improvements: ImprovementQueue;
  logger?: Logger;
  /**
   * Database URL for new app envs, with `{app}` (dashes become underscores) and `{env}` placeholders,
   * e.g. postgres://kelay:kelay@localhost:54320/app_{app}_{env}. Unset leaves envs without a database
   * until a provisioner calls PUT /internal/v1/apps/:app/envs/:env. A deploy to an env that still has
   * no database falls back to this template.
   */
  databaseUrlTemplate?: string;
  /** pg_trgm similarity at or above which new feedback merges into an open ticket. */
  dedupeThreshold?: number;
  /** Applies a version's schema and access rules to the env's app database on deploy and publish. Defaults to PgAppDatabaseMigrator. */
  appMigrator?: AppDatabaseMigrator;
  /** Connections to app databases, for "preview as" and QA. Defaults to one small pool per database. */
  appDbs?: AppDatabases;
  /** What `POST /v1/apps/:app/qa/run` executes. Defaults to the access checks of PolicyQaRunner. */
  qa?: QaRunner;
  /** Lifetime of the app-runtime caller token minted at deploy; a new deploy mints a new one. */
  callerTokenTtlSeconds?: number;
  now?: () => Date;
}

export type Ctx = Required<Omit<ControlApiDeps, 'databaseUrlTemplate'>> & Pick<ControlApiDeps, 'databaseUrlTemplate'>;

export const DEFAULT_DEDUPE_THRESHOLD = 0.45;
export const DEFAULT_CALLER_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
