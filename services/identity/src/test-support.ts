// Test helpers: a throwaway database per test file on the identity test container, and a cookie-keeping browser.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { CookieJar } from 'tough-cookie';
import type { AppMemberRow, AppRegistry, AppSchema } from '@kelay/contracts';
import { loadAppRegistry } from '@kelay/contracts/registry';
import { createIdentity, type Identity, type IdentityDeps } from './index.ts';

export const ADMIN_DATABASE_URL =
  process.env.IDENTITY_TEST_DATABASE_URL ?? 'postgres://postgres:kelay@localhost:54333/postgres';
export const ISSUER = 'http://localhost:4001';
export const MCP_BASE = 'http://localhost:4004';
export const PASSWORD = 'correct horse battery staple';

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
  const identity = createIdentity({
    database: pool,
    issuer: ISSUER,
    secret: 'identity-test-secret-0123456789abcdef',
    registry: testRegistry(),
    mcpPublicBaseUrl: MCP_BASE,
    ...overrides,
  });
  await identity.migrate();
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
