import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { CALLER_HEADER, audienceForApp } from '@kelay/contracts';
import { migrationSql } from '@kelay/policy';
import { createDevSigner, signCallerToken, type DevSigner } from '@kelay/tokens';
import { createControlApi } from '../src/app.ts';
import { createAppDatabases } from '../src/appdb.ts';
import { CONSOLE_APP } from '../src/auth.ts';
import { createDatabase, runMigrations, type Database } from '../src/db/client.ts';
import { LocalDeployDriver, type DeployDriver } from '../src/deploy/driver.ts';
import { PgAppDatabaseMigrator, type AppMigrationInput } from '../src/deploy/migrator.ts';
import type { RouteStore } from '../src/deploy/routes.ts';
import { createLogger } from '../src/log.ts';
import type { AppInfo, Llm, ReportDraft, ReportRequest, TriageItem, TriageLabel } from '../src/llm/types.ts';
import type { QaRunner } from '../src/qa/runner.ts';
import { PgImprovementQueue, type ImprovementQueue } from '../src/queue/improvement.ts';
import type { ImprovementRunRow } from '../src/db/schema.ts';
import { ADMIN_URL } from './global-setup.ts';

export const CALLER_SECRET = 'test-caller-secret-0123456789abcdef';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../packages/contracts/fixtures/ticket-board/${name}`, import.meta.url), 'utf8'));
export const ticketBoardSchema = fixture('schema.json');
export const ticketBoardPolicy = fixture('policy.json');

/** Deterministic stand-in for the model: keywords decide the label, the report cites the top tickets. */
export class FakeLlm implements Llm {
  triageCalls: TriageItem[] = [];
  reportCalls: ReportRequest[] = [];
  failOn: string | null = null;

  async triage(_app: AppInfo, item: TriageItem): Promise<TriageLabel> {
    this.triageCalls.push(item);
    const t = item.text.toLowerCase();
    if (this.failOn && t.includes(this.failOn)) throw new Error('fake model failure');
    if (/^(asdf|test|lol)\b/.test(t)) return { valid: false, type: 'feat', priority: 'low', title: 'Noise' };
    if (/error|broken|crash/.test(t)) return { valid: true, type: 'bug', priority: 'high', title: `Bug: ${item.text.slice(0, 40)}` };
    if (/slow|takes/.test(t)) return { valid: true, type: 'quality', priority: 'med', title: `Slow: ${item.text.slice(0, 40)}` };
    if (/confus|can't tell|cut off/.test(t)) return { valid: true, type: 'ux', priority: 'med', title: `UX: ${item.text.slice(0, 40)}` };
    return { valid: true, type: 'feat', priority: 'med', title: `Wish: ${item.text.slice(0, 40)}` };
  }

  async report(req: ReportRequest): Promise<ReportDraft> {
    this.reportCalls.push(req);
    const [first, second] = req.tickets;
    return {
      summary: `${req.tickets.length} open tickets; the top one is ${first?.key}.`,
      proposals: [
        { title: `Fix ${first?.title}`, body: 'Do the thing.', refs: [first!.key, 'FB-999'], impact: 'High', effort: 'S', affects: 'board screen' },
        ...(second ? [{ title: `Improve ${second.title}`, body: 'Then the other thing.', refs: [second.key], impact: 'Med' as const, effort: 'M' as const, affects: 'access rule' }] : []),
      ],
    };
  }
}

export class RecordingQueue implements ImprovementQueue {
  readonly kind = 'postgres';
  enqueued: ImprovementRunRow[] = [];
  constructor(private readonly inner: PgImprovementQueue) {}
  async enqueue(run: ImprovementRunRow) {
    this.enqueued.push(run);
    await this.inner.enqueue(run);
  }
}

export interface Harness {
  app: ReturnType<typeof createControlApi>;
  database: Database;
  signer: DevSigner;
  llm: FakeLlm;
  deploy: DeployDriver;
  queue: RecordingQueue;
  /** Every app database migration a deploy or publish asked for, in order. */
  migrations: AppMigrationInput[];
  databaseUrl: string;
  builder(sub: string, role?: string): Promise<string>;
  appUser(app: string, sub: string, extra?: { org?: string; role?: string; plan?: string }): Promise<string>;
  appCaller(app: string, env?: 'dev' | 'prod'): Promise<string>;
  service(svc?: string): Promise<string>;
  req(method: string, path: string, opts?: { token?: string; caller?: string; body?: unknown }): Promise<{ status: number; body: any }>;
  /**
   * Creates an app database migrated to the ticket-board fixture, points the app's env at it and deploys the
   * fixture schema and policy there. `sql` runs queries as the database owner, who bypasses RLS.
   */
  appDatabase(app: string, builder: string, env?: 'dev' | 'prod'): Promise<{ url: string; sql: pg.Client['query'] }>;
  close(): Promise<void>;
}

export async function createHarness(opts: { deploy?: DeployDriver; dedupeThreshold?: number; qa?: QaRunner; routes?: RouteStore } = {}): Promise<Harness> {
  const name = `control_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const databaseUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const database = createDatabase(databaseUrl, { max: 5 });
  await runMigrations(database.db);

  const signer = await createDevSigner();
  const llm = new FakeLlm();
  const deploy = opts.deploy ?? new LocalDeployDriver();
  const queue = new RecordingQueue(new PgImprovementQueue(database.db));
  const appDbs = createAppDatabases();
  // The template below names databases of the compose stack. A test must never touch those, so only
  // databases made by `appDatabase` are really migrated; every request is recorded.
  const migrations: AppMigrationInput[] = [];
  const ownDatabases = new Set<string>();
  const pgMigrator = new PgAppDatabaseMigrator();
  const app = createControlApi({
    db: database.db,
    appDbs,
    appMigrator: {
      async migrate(input) {
        migrations.push(input);
        if (ownDatabases.has(input.databaseUrl)) await pgMigrator.migrate(input);
      },
    },
    auth: { issuer: signer.issuer, jwks: signer.verifier, callerSecret: CALLER_SECRET },
    llm,
    deploy,
    improvements: queue,
    logger: createLogger('silent'),
    databaseUrlTemplate: 'postgres://kelay:kelay@localhost:54320/app_{app}_{env}',
    ...(opts.dedupeThreshold ? { dedupeThreshold: opts.dedupeThreshold } : {}),
    ...(opts.qa ? { qa: opts.qa } : {}),
    ...(opts.routes ? { routes: opts.routes } : {}),
  });
  const appDatabases: { name: string; client: pg.Client }[] = [];

  const h: Harness = {
    app,
    database,
    signer,
    llm,
    deploy,
    queue,
    migrations,
    databaseUrl,
    builder: (sub, role = 'builder') =>
      signer.sign({ sub, app: CONSOLE_APP, aud: audienceForApp(CONSOLE_APP), org: 'kelay', role, plan: 'pro' }),
    appUser: (appSlug, sub, extra = {}) =>
      signer.sign({ sub, app: appSlug, aud: audienceForApp(appSlug), org: extra.org ?? 'orum', role: extra.role ?? 'member', plan: extra.plan ?? 'free' }),
    appCaller: (appSlug, env = 'prod') => signCallerToken({ kind: 'app-runtime', app: appSlug, env }, CALLER_SECRET),
    service: (svc = 'test') => signCallerToken({ kind: 'service', svc }, CALLER_SECRET),
    async req(method, path, o = {}) {
      const headers: Record<string, string> = {};
      if (o.token) headers.authorization = `Bearer ${o.token}`;
      if (o.caller) headers[CALLER_HEADER] = o.caller;
      if (o.body !== undefined) headers['content-type'] = 'application/json';
      const res = await app.request(path, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async appDatabase(appSlug, builder, env = 'dev') {
      const dbName = `${name}_app${appDatabases.length}`;
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`create database ${dbName}`);
      await a.end();
      const url = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
      ownDatabases.add(url);
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      appDatabases.push({ name: dbName, client });
      await client.query(migrationSql({ ...ticketBoardSchema, app: appSlug }, ticketBoardPolicy));
      const put = await h.req('PUT', `/internal/v1/apps/${appSlug}/envs/${env}`, { caller: await h.service('provisioner'), body: { databaseUrl: url } });
      if (put.status !== 200) throw new Error(`appDatabase ${appSlug}: ${put.status} ${JSON.stringify(put.body)}`);
      const deployed = await h.req('POST', `/v1/apps/${appSlug}/envs/${env}/deploy`, {
        token: builder,
        body: { commit: 'a1', artifactUrl: `s3://kelay-builds/${appSlug}/a1.zip`, configVersion: 'cfg-a1', schema: { ...ticketBoardSchema, app: appSlug }, policy: ticketBoardPolicy },
      });
      if (deployed.status !== 201) throw new Error(`appDatabase ${appSlug}: deploy ${deployed.status} ${JSON.stringify(deployed.body)}`);
      return { url, sql: client.query.bind(client) as pg.Client['query'] };
    },
    async close() {
      await database.close();
      await appDbs.close();
      await Promise.all(appDatabases.map((d) => d.client.end()));
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      for (const d of appDatabases) await a.query(`drop database if exists ${d.name} with (force)`);
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
  return h;
}

/** Creates an app owned by `sub` and returns the builder token. */
export async function seedApp(h: Harness, sub: string, slug: string, extra: Record<string, unknown> = {}) {
  const token = await h.builder(sub);
  const res = await h.req('POST', '/v1/apps', { token, body: { slug, name: slug, handle: `h-${sub}`, ...extra } });
  if (res.status !== 201) throw new Error(`seedApp ${slug}: ${res.status} ${JSON.stringify(res.body)}`);
  return token;
}
