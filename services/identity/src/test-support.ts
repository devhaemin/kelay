// Test helpers: a throwaway database per test file on the identity test container, and a cookie-keeping browser.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { CookieJar } from 'tough-cookie';
import { CALLER_HEADER, type AppMemberRow, type AppRegistry, type AppSchema } from '@kelay/contracts';
import { loadAppRegistry } from '@kelay/contracts/registry';
import { verifyCallerToken } from '@kelay/tokens';
import { controlApiConsents, createIdentity, migrateIdentity, type ConsentRecord, type ConsentRecorder, type Identity, type IdentityDeps } from './index.ts';

export const ADMIN_DATABASE_URL =
  process.env.IDENTITY_TEST_DATABASE_URL ?? 'postgres://postgres:kelay@localhost:54333/postgres';
export const ISSUER = 'http://localhost:4001';
export const MCP_BASE = 'http://localhost:4004';
export const PASSWORD = 'correct horse battery staple';
export const CONTROL_API_URL = 'http://localhost:4003';
export const CALLER_SECRET = 'identity-test-caller-secret-0123456789abcdef';

// The real migration belongs to control-api (contract §9); this is the same shape.
const APP_MEMBERS_DDL = `create table app_members (
  app text, user_id text, org text, role text, plan text, status text, primary key (app, user_id))`;

const minimalSchema = (app: string): AppSchema => ({
  app,
  roles: ['member'],
  collections: [{ name: 'items', fields: { title: { type: 'text' } } }],
});

/** ticket-board (orum) from the contracts fixture, plus wiki (orum) and notes (acme). */
export function testRegistry(): AppRegistry {
  const fixture = loadAppRegistry(
    fileURLToPath(new URL('../../../packages/contracts/fixtures/apps.local.json', import.meta.url)),
  );
  return {
    apps: {
      ...fixture.apps,
      wiki: { handle: 'orum', databaseUrl: '', schema: minimalSchema('wiki') },
      notes: { handle: 'acme', databaseUrl: '', schema: minimalSchema('notes') },
    },
  };
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export interface TestIdentity {
  identity: Identity;
  pool: pg.Pool;
  setMember(row: AppMemberRow): Promise<void>;
  close(): Promise<void>;
}

export async function startTestIdentity(overrides: Partial<IdentityDeps> = {}): Promise<TestIdentity> {
  const name = `identity_${randomUUID().replaceAll('-', '')}`;
  await withAdmin((c) => c.query(`create database ${name}`));
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  await pool.query(APP_MEMBERS_DDL);
  const deps: IdentityDeps = {
    database: pool,
    issuer: ISSUER,
    secret: 'identity-test-secret-0123456789abcdef',
    registry: testRegistry(),
    mcpPublicBaseUrl: MCP_BASE,
    ...overrides,
  };
  await migrateIdentity(deps);
  const identity = createIdentity(deps);
  return {
    identity,
    pool,
    async setMember(m) {
      await pool.query(
        `insert into app_members (app, user_id, org, role, plan, status) values ($1, $2, $3, $4, $5, $6)
         on conflict (app, user_id) do update
         set org = excluded.org, role = excluded.role, plan = excluded.plan, status = excluded.status`,
        [m.app, m.user_id, m.org, m.role, m.plan, m.status],
      );
    },
    async close() {
      await pool.end();
      await withAdmin((c) => c.query(`drop database ${name} with (force)`));
    },
  };
}

/**
 * The control API's side of a consent, without the control API: it takes `PUT /internal/v1/consents`
 * from a `service` caller, and revokes the way the real one does, by deleting Kelay ID's consent row
 * and refresh tokens in the database both services share.
 */
export class FakeControlApi {
  /** Every consent Kelay ID recorded, in order. */
  readonly recorded: ConsentRecord[] = [];
  /** Answers 503 while true. */
  down = false;

  constructor(private readonly pool: pg.Pool) {}

  get recorder(): ConsentRecorder {
    return controlApiConsents({
      controlApiUrl: CONTROL_API_URL,
      callerSecret: CALLER_SECRET,
      fetch: async (url, init) => {
        if (this.down) return Response.json({ error: { code: 'internal', message: 'down' } }, { status: 503 });
        const caller = await verifyCallerToken(new Headers(init.headers).get(CALLER_HEADER) ?? '', CALLER_SECRET).catch(() => null);
        if (caller?.kind !== 'service') return Response.json({ error: { code: 'forbidden_caller', message: 'service caller required' } }, { status: 403 });
        if (init.method !== 'PUT' || url !== `${CONTROL_API_URL}/internal/v1/consents`) return new Response(null, { status: 404 });
        const consent = JSON.parse(String(init.body)) as ConsentRecord;
        this.recorded.push(consent);
        return Response.json({ consent: { ...consent, active: true } });
      },
    });
  }

  async revoke(consent: Pick<ConsentRecord, 'userId' | 'app' | 'clientId'>): Promise<void> {
    for (const table of ['oauthConsent', 'oauthRefreshToken']) {
      await this.pool.query(`delete from "${table}" where "userId" = $1 and "clientId" = $2 and "referenceId" = $3`, [
        consent.userId,
        consent.clientId,
        consent.app,
      ]);
    }
  }
}

/** Drives the Hono app like a browser on the issuer origin: keeps cookies, never follows redirects. */
export class Browser {
  readonly jar = new CookieJar();

  constructor(private readonly app: Identity['app']) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, ISSUER).toString();
    const headers = new Headers(init.headers);
    const cookie = await this.jar.getCookieString(url);
    if (cookie) headers.set('cookie', cookie);
    const res = await this.app.request(url, { ...init, headers });
    for (const setCookie of res.headers.getSetCookie()) await this.jar.setCookie(setCookie, url);
    return res;
  }

  get(path: string): Promise<Response> {
    return this.request(path);
  }

  postForm(path: string, fields: Record<string, string>): Promise<Response> {
    return this.request(path, {
      method: 'POST',
      headers: { origin: ISSUER, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  }

  postJson(path: string, body: unknown): Promise<Response> {
    return this.request(path, {
      method: 'POST',
      headers: { origin: ISSUER, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Signs up through better-auth's JSON API and returns the new user's id. */
  async signUp(email: string, name = email.split('@')[0]!): Promise<string> {
    const res = await this.postJson('/api/auth/sign-up/email', { name, email, password: PASSWORD });
    if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { user: { id: string } }).user.id;
  }
}
