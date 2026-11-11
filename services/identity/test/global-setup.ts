// Tests run against a disposable postgres:17 on port 54333 (contract §11). If nothing listens there,
// start one and remove it afterwards; a container someone else started is left alone.
import { execFileSync } from 'node:child_process';
import pg from 'pg';

export const ADMIN_URL = process.env.CONTROL_TEST_DATABASE_URL ?? 'postgres://postgres:kelay@localhost:54333/postgres';
const CONTAINER = 'kelay-pg-identity';

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

/**
 * Roles are shared by every database of the server. Test files migrate app databases in parallel, and
 * two of them creating kelay_runtime at once would collide, so it is created here, once.
 */
async function createRuntimeRole(): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kelay_runtime') THEN CREATE ROLE kelay_runtime NOLOGIN NOBYPASSRLS; END IF;
    END $$`);
  } finally {
    await client.end();
  }
}

export default async function setup() {
  if (await reachable()) return createRuntimeRole();
  execFileSync('docker', ['run', '-d', '--rm', '--name', CONTAINER, '-p', '54333:5432', '-e', 'POSTGRES_PASSWORD=kelay', 'postgres:17'], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    if (await reachable()) {
      await createRuntimeRole();
      return () => {
        execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' });
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' });
  throw new Error(`postgres did not become ready at ${ADMIN_URL}`);
}
