import type { AuthConfig } from './auth.ts';
import type { Db } from './db/client.ts';
import type { DeployDriver } from './deploy/driver.ts';
import type { Llm } from './llm/types.ts';
import type { Logger } from './log.ts';
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
   * until a provisioner calls PUT /internal/v1/apps/:app/envs/:env.
   */
  databaseUrlTemplate?: string;
  /** pg_trgm similarity at or above which new feedback merges into an open ticket. */
  dedupeThreshold?: number;
  now?: () => Date;
}

export type Ctx = Required<Omit<ControlApiDeps, 'databaseUrlTemplate'>> & Pick<ControlApiDeps, 'databaseUrlTemplate'>;

export const DEFAULT_DEDUPE_THRESHOLD = 0.45;
