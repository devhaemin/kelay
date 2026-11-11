// Brings up the whole platform for the e2e run: a disposable postgres:17 on port 54336 (contract
// §11), migrations, the dev seed, and the four services as real processes on their own ports, so a
// `pnpm dev:up` in another terminal is left alone. Everything is stopped afterwards.
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { ROOT, configFromEnv, type StackConfig } from '../scripts/lib/config.ts';
import { HANDLE, type TeamKey } from '../scripts/lib/data.ts';
import { migrate } from '../scripts/lib/migrate.ts';
import { seed } from '../scripts/lib/seed.ts';
import { startStack, type RunningStack } from '../scripts/lib/services.ts';

export interface E2eStack {
  config: StackConfig;
  builderId: string;
  users: Record<TeamKey, string>;
}

declare module 'vitest' {
  export interface ProvidedContext {
    stack: E2eStack;
  }
}

const CONTAINER = 'kelay-pg-e2e';
const PG_PORT = 54336;
const PORTS = { identity: 4411, dataApi: 4412, controlApi: 4413, mcpGateway: 4414 };
const WORK_DIR = resolve(ROOT, 'node_modules/.cache/kelay/e2e');

const docker = (...args: string[]) => execFileSync('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] });

async function waitForPostgres(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('select 1');
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`postgres not ready at ${url}: ${(e as Error).message}`);
      await sleep(500);
    } finally {
      await client.end().catch(() => {});
    }
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  try {
    docker('rm', '-f', CONTAINER);
  } catch {
    // No leftover container from an earlier run.
  }
  docker('run', '-d', '--rm', '--name', CONTAINER, '-p', `${PG_PORT}:5432`, '-e', 'POSTGRES_PASSWORD=kelay', 'postgres:17');
  let stack: RunningStack | undefined;
  const teardown = async () => {
    await stack?.stop();
    docker('stop', CONTAINER);
  };

  try {
    const server = `postgres://postgres:kelay@localhost:${PG_PORT}`;
    await waitForPostgres(`${server}/postgres`);

    // The fixture registry points at the compose database; this copy points at the disposable one.
    mkdirSync(WORK_DIR, { recursive: true });
    const require = createRequire(import.meta.url);
    const appsFile = resolve(WORK_DIR, 'apps.e2e.json');
    writeFileSync(
      appsFile,
      JSON.stringify({
        apps: {
          'ticket-board': {
            handle: HANDLE,
            databaseUrl: `${server}/app_ticket_board_e2e`,
            schemaFile: require.resolve('@kelay/contracts/fixtures/ticket-board/schema.json'),
            policyFile: require.resolve('@kelay/contracts/fixtures/ticket-board/policy.json'),
          },
        },
      }),
    );

    const config = configFromEnv({
      CONTROL_DATABASE_URL: `${server}/kelay_control_e2e`,
      KELAY_APPS_FILE: appsFile,
      KELAY_ID_ISSUER: `http://localhost:${PORTS.identity}`,
      DATA_API_URL: `http://localhost:${PORTS.dataApi}`,
      CONTROL_API_URL: `http://localhost:${PORTS.controlApi}`,
      MCP_PUBLIC_BASE_URL: `http://localhost:${PORTS.mcpGateway}`,
      KELAY_CALLER_SECRET: 'e2e-caller-secret-0123456789abcdef-0123',
      BETTER_AUTH_SECRET: 'e2e-identity-secret-0123456789abcdef',
    });

    await migrate(config);
    const seeded = await seed(config);
    stack = await startStack(config, {
      watch: false,
      console: false,
      identityEntry: 'e2e/identity-server.ts',
      output: createWriteStream(resolve(WORK_DIR, 'services.log')),
    });
    project.provide('stack', { config, builderId: seeded.builderId, users: seeded.users });
  } catch (e) {
    await teardown().catch(() => {});
    throw e;
  }
  return teardown;
}
