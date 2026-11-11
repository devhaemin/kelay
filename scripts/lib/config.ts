// One description of the local stack, read from the environment (.env, see .env.example). The dev
// scripts and the e2e suite both build on it, so they migrate, seed and start services the same way.
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadAppRegistry } from '@kelay/contracts/registry';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const TICKET_BOARD = 'ticket-board';

export interface StackConfig {
  controlDatabaseUrl: string;
  /** Database of the ticket-board app, taken from the app registry file. */
  appDatabaseUrl: string;
  /** Absolute path of KELAY_APPS_FILE. */
  appsFile: string;
  issuer: string;
  jwksUrl: string;
  callerSecret: string;
  /** BETTER_AUTH_SECRET: encrypts Kelay ID's signing keys, so the seed and the service must share it. */
  authSecret: string;
  dataApiUrl: string;
  controlApiUrl: string;
  mcpPublicBaseUrl: string;
  consoleUrl: string;
  devLoginUrl: string;
  /** Origin public app links are built from; the router that serves it is not part of the local stack. */
  appOrigin: string;
  llmGatewayUrl: string;
  llmGatewayKey: string;
  builderUrl: string;
  /** Where the Builder creates the database of an app it builds; `{app}` and `{env}` are filled in. */
  appDatabaseUrlTemplate: string;
}

type Env = Record<string, string | undefined>;

const DEFAULTS = {
  CONTROL_DATABASE_URL: 'postgres://kelay:kelay@localhost:54320/kelay_control',
  KELAY_ID_ISSUER: 'http://localhost:4001',
  KELAY_CALLER_SECRET: 'dev-caller-secret-change-me-32-bytes-min',
  BETTER_AUTH_SECRET: 'kelay-identity-dev-secret-not-for-production',
  KELAY_APPS_FILE: 'packages/contracts/fixtures/apps.local.json',
  DATA_API_URL: 'http://localhost:4002',
  CONTROL_API_URL: 'http://localhost:4003',
  MCP_PUBLIC_BASE_URL: 'http://localhost:4004',
  CONSOLE_URL: 'http://localhost:3000',
  DEV_LOGIN_URL: 'http://localhost:4005',
  KELAY_APP_ORIGIN: 'http://localhost:8787',
  LLM_GATEWAY_URL: 'http://localhost:4000',
  LLM_GATEWAY_KEY: 'sk-kelay-dev',
  BUILDER_URL: 'http://localhost:4006',
  APP_DATABASE_URL_TEMPLATE: 'postgres://kelay:kelay@localhost:54320/app_{app}_{env}',
} as const;

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function configFromEnv(env: Env): StackConfig {
  const get = (name: keyof typeof DEFAULTS) => env[name] || DEFAULTS[name];
  const appsFile = get('KELAY_APPS_FILE');
  const absoluteAppsFile = isAbsolute(appsFile) ? appsFile : resolve(ROOT, appsFile);
  const board = loadAppRegistry(absoluteAppsFile).apps[TICKET_BOARD];
  if (!board) throw new Error(`${absoluteAppsFile} has no ${TICKET_BOARD} app`);
  const issuer = trimSlash(get('KELAY_ID_ISSUER'));
  return {
    controlDatabaseUrl: get('CONTROL_DATABASE_URL'),
    appDatabaseUrl: board.databaseUrl,
    appsFile: absoluteAppsFile,
    issuer,
    jwksUrl: env.KELAY_ID_JWKS_URL || `${issuer}/api/auth/jwks`,
    callerSecret: get('KELAY_CALLER_SECRET'),
    authSecret: get('BETTER_AUTH_SECRET'),
    dataApiUrl: trimSlash(get('DATA_API_URL')),
    controlApiUrl: trimSlash(get('CONTROL_API_URL')),
    mcpPublicBaseUrl: trimSlash(get('MCP_PUBLIC_BASE_URL')),
    consoleUrl: trimSlash(get('CONSOLE_URL')),
    devLoginUrl: trimSlash(get('DEV_LOGIN_URL')),
    appOrigin: trimSlash(get('KELAY_APP_ORIGIN')),
    llmGatewayUrl: get('LLM_GATEWAY_URL'),
    llmGatewayKey: get('LLM_GATEWAY_KEY'),
    builderUrl: trimSlash(get('BUILDER_URL')),
    appDatabaseUrlTemplate: get('APP_DATABASE_URL_TEMPLATE'),
  };
}

/** Config for the dev scripts: the repo's .env first, then the defaults of .env.example. */
export function loadConfig(): StackConfig {
  loadDotenv({ path: resolve(ROOT, '.env'), quiet: true });
  return configFromEnv(process.env);
}

export function portOf(url: string): number {
  const u = new URL(url);
  return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
}

/** What every service process reads (docs/contracts.md §4–§8). */
export function serviceEnv(cfg: StackConfig): Record<string, string> {
  return {
    CONTROL_DATABASE_URL: cfg.controlDatabaseUrl,
    KELAY_ID_ISSUER: cfg.issuer,
    KELAY_ID_JWKS_URL: cfg.jwksUrl,
    KELAY_CALLER_SECRET: cfg.callerSecret,
    BETTER_AUTH_SECRET: cfg.authSecret,
    KELAY_APPS_FILE: cfg.appsFile,
    DATA_API_URL: cfg.dataApiUrl,
    CONTROL_API_URL: cfg.controlApiUrl,
    MCP_PUBLIC_BASE_URL: cfg.mcpPublicBaseUrl,
    CONSOLE_URL: cfg.consoleUrl,
    DEV_LOGIN_URL: cfg.devLoginUrl,
    KELAY_APP_ORIGIN: cfg.appOrigin,
    LLM_GATEWAY_URL: cfg.llmGatewayUrl,
    LLM_GATEWAY_KEY: cfg.llmGatewayKey,
    BUILDER_URL: cfg.builderUrl,
  };
}
