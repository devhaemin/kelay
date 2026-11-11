// One description of the local stack, read from the environment (.env, see .env.example). The dev
// scripts and the e2e suite both build on it, so they migrate, seed and start services the same way.
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadAppRegistry } from '@kelay/contracts/registry';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const TICKET_BOARD = 'ticket-board';
/** `docker compose` arguments naming the root stack plus the local LLM gateway. */
export const COMPOSE_FILES = ['-f', 'docker-compose.yml', '-f', 'infra/local/compose.services.yml'];

export interface StackConfig {
  controlDatabaseUrl: string;
  /** Database of the ticket-board app, taken from the app registry file. */
  appDatabaseUrl: string;
  /** Absolute path of KELAY_APPS_FILE: where the migration and the seed read Ticket Board from. */
  appsFile: string;
  /** KELAY_APPS_SOURCE for the services (contract §6). `control-api`, so an app the Builder just deployed is known. */
  appsSource: string;
  /** KELAY_APPS_TTL_SECONDS: how long the services reuse a registry answer. */
  appsTtlSeconds: string;
  issuer: string;
  jwksUrl: string;
  callerSecret: string;
  /** BETTER_AUTH_SECRET: encrypts Kelay ID's signing keys, so the seed and the service must share it. */
  authSecret: string;
  dataApiUrl: string;
  controlApiUrl: string;
  mcpPublicBaseUrl: string;
  runnerUrl: string;
  /** RUNNER_LOCAL_NODES: `<app>=<module>` pairs the run orchestrator's local driver loads. */
  runnerNodes: string;
  consoleUrl: string;
  devLoginUrl: string;
  /** Origin public app links are built from; the router that serves it is not part of the local stack. */
  appOrigin: string;
  /** Unset when nothing serves model calls: triage, reports and agent nodes then fail with "LLM gateway not configured". */
  llmGatewayUrl: string | undefined;
  llmGatewayKey: string;
  /** Whether `pnpm dev:up` starts LiteLLM itself: a provider key is set and no other gateway is named. */
  startLlmGateway: boolean;
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
  KELAY_APPS_SOURCE: 'control-api',
  // Short, so a schema the Builder deployed a moment ago is what the Data API checks the next call against.
  KELAY_APPS_TTL_SECONDS: '5',
  DATA_API_URL: 'http://localhost:4002',
  CONTROL_API_URL: 'http://localhost:4003',
  MCP_PUBLIC_BASE_URL: 'http://localhost:4004',
  RUNNER_URL: 'http://localhost:4007',
  CONSOLE_URL: 'http://localhost:3000',
  DEV_LOGIN_URL: 'http://localhost:4005',
  KELAY_APP_ORIGIN: 'http://localhost:8787',
  LLM_GATEWAY_KEY: 'sk-kelay-dev',
  BUILDER_URL: 'http://localhost:4006',
  APP_DATABASE_URL_TEMPLATE: 'postgres://kelay:kelay@localhost:54320/app_{app}_{env}',
} as const;

/** Where the LiteLLM container of infra/local/compose.services.yml listens. */
export const LOCAL_LLM_GATEWAY_URL = 'http://localhost:4000';
/** Ticket Board's agent nodes, loaded by the run orchestrator's local driver. */
const TICKET_BOARD_NODES = 'examples/ticket-board-nodes/src/index.ts';

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function configFromEnv(env: Env): StackConfig {
  const get = (name: keyof typeof DEFAULTS) => env[name] || DEFAULTS[name];
  const appsFile = get('KELAY_APPS_FILE');
  const absoluteAppsFile = isAbsolute(appsFile) ? appsFile : resolve(ROOT, appsFile);
  const board = loadAppRegistry(absoluteAppsFile).apps[TICKET_BOARD];
  if (!board) throw new Error(`${absoluteAppsFile} has no ${TICKET_BOARD} app`);
  const issuer = trimSlash(get('KELAY_ID_ISSUER'));
  // A gateway that runs elsewhere is used as it is. The local one exists only when there is a
  // provider key for it to call with, whether or not .env names its address.
  const named = env.LLM_GATEWAY_URL ? trimSlash(env.LLM_GATEWAY_URL) : undefined;
  const namedGateway = named === LOCAL_LLM_GATEWAY_URL ? undefined : named;
  const startLlmGateway = !!env.ANTHROPIC_API_KEY && namedGateway === undefined;
  return {
    controlDatabaseUrl: get('CONTROL_DATABASE_URL'),
    appDatabaseUrl: board.databaseUrl,
    appsFile: absoluteAppsFile,
    appsSource: get('KELAY_APPS_SOURCE'),
    appsTtlSeconds: get('KELAY_APPS_TTL_SECONDS'),
    issuer,
    jwksUrl: env.KELAY_ID_JWKS_URL || `${issuer}/api/auth/jwks`,
    callerSecret: get('KELAY_CALLER_SECRET'),
    authSecret: get('BETTER_AUTH_SECRET'),
    dataApiUrl: trimSlash(get('DATA_API_URL')),
    controlApiUrl: trimSlash(get('CONTROL_API_URL')),
    mcpPublicBaseUrl: trimSlash(get('MCP_PUBLIC_BASE_URL')),
    runnerUrl: trimSlash(get('RUNNER_URL')),
    runnerNodes: env.RUNNER_LOCAL_NODES || `${TICKET_BOARD}=${resolve(ROOT, TICKET_BOARD_NODES)}`,
    consoleUrl: trimSlash(get('CONSOLE_URL')),
    devLoginUrl: trimSlash(get('DEV_LOGIN_URL')),
    appOrigin: trimSlash(get('KELAY_APP_ORIGIN')),
    llmGatewayUrl: namedGateway ?? (startLlmGateway ? LOCAL_LLM_GATEWAY_URL : undefined),
    llmGatewayKey: get('LLM_GATEWAY_KEY'),
    startLlmGateway,
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
    KELAY_APPS_SOURCE: cfg.appsSource,
    KELAY_APPS_TTL_SECONDS: cfg.appsTtlSeconds,
    KELAY_APPS_FILE: cfg.appsFile,
    DATA_API_URL: cfg.dataApiUrl,
    CONTROL_API_URL: cfg.controlApiUrl,
    MCP_PUBLIC_BASE_URL: cfg.mcpPublicBaseUrl,
    RUNNER_URL: cfg.runnerUrl,
    RUNNER_LOCAL_NODES: cfg.runnerNodes,
    CONSOLE_URL: cfg.consoleUrl,
    DEV_LOGIN_URL: cfg.devLoginUrl,
    KELAY_APP_ORIGIN: cfg.appOrigin,
    // An empty value overrides one inherited from the shell, so "no gateway" is the same in every service.
    LLM_GATEWAY_URL: cfg.llmGatewayUrl ?? '',
    LLM_GATEWAY_KEY: cfg.llmGatewayUrl ? cfg.llmGatewayKey : '',
    BUILDER_URL: cfg.builderUrl,
  };
}
