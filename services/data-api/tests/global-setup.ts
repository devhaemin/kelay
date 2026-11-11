// Starts the disposable Postgres container for this package (contract §11 port 54332), installs
// kelay_auth.sql plus the ticket-board fixture, and stops the container after the run.
// Set DATA_API_TEST_DATABASE_URL to run against an existing database instead.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const CONTAINER = 'kelay-pg-data';
const PORT = 54332;

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

export default async function setup(project: TestProject): Promise<() => void> {
  const external = process.env.DATA_API_TEST_DATABASE_URL;
  if (!external) {
    try {
      docker('rm', '-f', CONTAINER);
    } catch {
      // No leftover container from an earlier run.
    }
    docker('run', '-d', '--rm', '--name', CONTAINER, '-p', `${PORT}:5432`, '-e', 'POSTGRES_PASSWORD=kelay', 'postgres:17');
  }
  const stop = () => {
    if (!external) docker('stop', CONTAINER);
  };
  const url = external ?? `postgres://postgres:kelay@localhost:${PORT}/postgres`;
  try {
    await waitForPostgres(url);
    const require = createRequire(import.meta.url);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(readFileSync(require.resolve('@kelay/contracts/sql/kelay_auth.sql'), 'utf8'));
      await client.query(readFileSync(new URL('./fixtures/ticket-board.sql', import.meta.url), 'utf8'));
    } finally {
      await client.end();
    }
  } catch (e) {
    stop();
    throw e;
  }
  project.provide('databaseUrl', url);
  return stop;
}
