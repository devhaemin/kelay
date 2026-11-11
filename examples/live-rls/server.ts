// Live demo of the Kelay trust boundary: every request carries a signed Kelay ID token,
// and Postgres RLS (not app code) decides what each person can see and move.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { audienceForApp, RUNTIME_DB_ROLE } from '@kelay/contracts';
import { createDevSigner, verifyKelayToken } from '@kelay/tokens';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:kelay@localhost:54340/postgres' });
const signer = await createDevSigner();

const PEOPLE: Record<string, { name: string; role: string; org: string }> = {
  junho: { name: 'Junho Park', role: 'member', org: 'orum' },
  seoyeon: { name: 'Seoyeon Kim', role: 'admin', org: 'orum' },
  hyunwoo: { name: 'Hyunwoo Lee', role: 'guest', org: 'orum' },
};

await pool.query(readFileSync(here('../../packages/contracts/sql/kelay_auth.sql'), 'utf8'));
await pool.query(readFileSync(here('./seed.sql'), 'utf8'));

async function asUser<T>(token: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const claims = await verifyKelayToken(token, { jwks: signer.verifier, issuer: signer.issuer, app: 'ticket-board' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await c.query(`SET LOCAL ROLE ${RUNTIME_DB_ROLE}`);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

const tokenFor = (id: string) => {
  const p = PEOPLE[id];
  if (!p) throw new Error('unknown person');
  return signer.sign({ sub: id, app: 'ticket-board', org: p.org, role: p.role, plan: 'free', aud: audienceForApp('ticket-board') });
};

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(here('./index.html')));
    }
    if (url.pathname === '/api/people') return json(res, 200, PEOPLE);
    if (url.pathname === '/api/token') return json(res, 200, { token: await tokenFor(url.searchParams.get('as') ?? '') });
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (url.pathname === '/api/tickets') {
      const rows = await asUser(token, async (c) => (await c.query('SELECT * FROM app.tickets ORDER BY due_on')).rows);
      const total = (await pool.query("SELECT count(*)::int AS n FROM app.tickets WHERE org_id = 'orum'")).rows[0].n;
      return json(res, 200, { rows, total });
    }
    if (url.pathname === '/api/move' && req.method === 'POST') {
      let raw = '';
      for await (const ch of req) raw += ch;
      const { id, status } = JSON.parse(raw);
      if (!['todo', 'doing', 'review', 'done'].includes(status)) return json(res, 400, { error: { code: 'invalid_request', message: 'bad status' } });
      const rows = await asUser(token, async (c) =>
        (await c.query('UPDATE app.tickets SET status = $1, updated_at = now() WHERE id = $2 RETURNING *', [status, id])).rows);
      // RLS filtered the row out of the UPDATE: report it as denied instead of a silent no-op (contract §5).
      if (rows.length === 0) return json(res, 403, { error: { code: 'denied', message: 'Only the assignee can move this ticket.' } });
      return json(res, 200, { rows });
    }
    json(res, 404, { error: { code: 'invalid_request', message: 'not found' } });
  } catch (e) {
    const denied = (e as { code?: string }).code === '42501';
    json(res, denied ? 403 : 401, { error: { code: denied ? 'denied' : 'unauthenticated', message: (e as Error).message } });
  }
}).listen(4100, () => console.log('Kelay live RLS demo → http://localhost:4100'));
