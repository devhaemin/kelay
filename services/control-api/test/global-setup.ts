// Tests run against a disposable postgres:17 on port 54334 (contract §11). If nothing listens there,
// start one and remove it afterwards; a container someone else started is left alone.
import { execFileSync } from 'node:child_process';
import pg from 'pg';

export const ADMIN_URL = process.env.CONTROL_TEST_DATABASE_URL ?? 'postgres://postgres:kelay@localhost:54334/postgres';
const CONTAINER = 'kelay-pg-control';

async function reachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 1000 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

export default async function setup() {
  if (await reachable()) return;
  execFileSync('docker', ['run', '-d', '--rm', '--name', CONTAINER, '-p', '54334:5432', '-e', 'POSTGRES_PASSWORD=kelay', 'postgres:17'], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    if (await reachable()) {
      return () => {
        execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' });
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' });
  throw new Error(`postgres did not become ready at ${ADMIN_URL}`);
}
