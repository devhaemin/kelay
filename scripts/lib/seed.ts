// Seeds the Ticket Board scenario through the services' own code paths, in process: accounts through
// Kelay ID sign-up, apps, envs, versions, members, grants and consents through Control API routes.
// Two weeks of activity go through the ingest routes the services use. Rows no route can produce with
// fixed content (feedback keys, model-written reports, app data) go straight into the databases. Every step skips what already exists, so re-running is safe.
import pg from 'pg';
import { CALLER_HEADER } from '@kelay/contracts';
import { loadAppRegistry } from '@kelay/contracts/registry';
import {
  LlmError,
  LocalDeployDriver,
  PgImprovementQueue,
  createControlApi,
  createDatabase,
  createLogger,
  schema as control,
  type Database,
  type Llm,
} from '@kelay/control-api';
import { createIdentity } from '@kelay/identity';
import { localJwks, signCallerToken } from '@kelay/tokens';
import { ACTIVITY_DAYS, buildActivity } from './activity.ts';
import { TICKET_BOARD, type StackConfig } from './config.ts';
import {
  APPS,
  BOARD,
  BUILDER,
  COMMENTS,
  CONSENTS,
  CONSOLE_APP,
  FEEDBACK,
  FOREIGN_TICKET,
  GRANTS,
  HANDLE,
  ORG,
  PASSWORD,
  PROJECTS,
  REPORTS,
  TEAM,
  type TeamKey,
} from './data.ts';
import { identityDeps, withClient } from './migrate.ts';
import { KelayIdSession } from './session.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The ingest routes take at most 500 records per request. */
const INGEST_BATCH = 500;

export interface SeedResult {
  builderId: string;
  users: Record<TeamKey, string>;
}

// Triage and reports are the only routes that call the model, and the seed uses neither.
const noModel: Llm = {
  triage: async () => {
    throw new LlmError('the seed does not call the model');
  },
  report: async () => {
    throw new LlmError('the seed does not call the model');
  },
};

interface Reply {
  status: number;
  body: any;
}

export async function seed(cfg: StackConfig, log: (line: string) => void = () => {}): Promise<SeedResult> {
  const pool = new pg.Pool({ connectionString: cfg.controlDatabaseUrl, max: 4 });
  const database = createDatabase(cfg.controlDatabaseUrl, { max: 4 });
  try {
    const identity = createIdentity(identityDeps(cfg, pool));
    const idFetch = (url: string, init?: RequestInit) => identity.app.request(url, init);

    // ---- accounts (Kelay ID)
    const builderSession = new KelayIdSession(cfg.issuer, idFetch);
    const builderId = await builderSession.signUpOrIn(BUILDER.name, BUILDER.email, PASSWORD);
    const users = {} as Record<TeamKey, string>;
    for (const person of TEAM) {
      users[person.key] = await new KelayIdSession(cfg.issuer, idFetch).signUpOrIn(person.name, person.email, PASSWORD);
    }
    log(`accounts: ${BUILDER.email} (builder), ${TEAM.map((p) => p.email).join(', ')}`);

    // The console is not an app row, so its membership has no route: the builder role is granted here.
    await pool.query(
      `insert into app_members (app, user_id, org, role, plan, status) values ($1, $2, $3, 'builder', 'pro', 'active')
       on conflict (app, user_id) do update set org = excluded.org, role = excluded.role, status = excluded.status`,
      [CONSOLE_APP, builderId, ORG],
    );
    const builderToken = await builderSession.appToken(CONSOLE_APP);
    const serviceToken = await signCallerToken({ kind: 'service', svc: 'seed' }, cfg.callerSecret);

    // ---- Control API, verifying the builder token against the same Kelay ID keys the services use
    const jwks = localJwks((await (await identity.app.request('/api/auth/jwks')).json()) as Parameters<typeof localJwks>[0]);
    const api = createControlApi({
      db: database.db,
      auth: { issuer: cfg.issuer, jwks, callerSecret: cfg.callerSecret },
      llm: noModel,
      deploy: new LocalDeployDriver(),
      improvements: new PgImprovementQueue(database.db),
      logger: createLogger('silent'),
    });
    const call = async (as: 'builder' | 'service', method: string, path: string, body?: unknown, allow: number[] = []): Promise<Reply> => {
      const headers: Record<string, string> = as === 'builder' ? { authorization: `Bearer ${builderToken}` } : { [CALLER_HEADER]: serviceToken };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await api.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      const reply = { status: res.status, body: text ? JSON.parse(text) : null };
      if (!res.ok && !allow.includes(res.status)) throw new Error(`seed: ${method} ${path} answered ${res.status} ${text}`);
      return reply;
    };

    // ---- apps, envs, versions
    const board = loadAppRegistry(cfg.appsFile).apps[TICKET_BOARD]!;
    for (const app of APPS) {
      await call('builder', 'POST', '/v1/apps', { ...app, handle: HANDLE }, [409]);
      if (app.slug === TICKET_BOARD) {
        // The local stack has one database for the app; dev and prod both point at it.
        for (const env of ['dev', 'prod']) {
          await call('service', 'PUT', `/internal/v1/apps/${app.slug}/envs/${env}`, { databaseUrl: cfg.appDatabaseUrl });
        }
      }
      const detail = await call('builder', 'GET', `/v1/apps/${app.slug}`);
      const active = (env: string) => detail.body.envs.find((e: { name: string }) => e.name === env)?.activeVersion ?? null;
      let dev = active('dev');
      if (!dev) {
        const deployed = await call('builder', 'POST', `/v1/apps/${app.slug}/envs/dev/deploy`, {
          commit: 'seed',
          artifactUrl: `local://${app.slug}`,
          configVersion: 'seed-1',
          ...(app.slug === TICKET_BOARD ? { schema: board.schema, policy: board.policy } : {}),
        });
        dev = deployed.body.version;
      }
      if (!active('prod')) await call('builder', 'POST', `/v1/apps/${app.slug}/publish`, { versionId: dev.id });
    }
    log(`apps: ${APPS.map((a) => `${HANDLE}/${a.slug}`).join(', ')} (deployed to dev, published)`);

    // ---- members
    for (const app of APPS) {
      for (const person of TEAM) {
        const role = app.slug === TICKET_BOARD ? person.role : undefined;
        await call('service', 'PUT', `/internal/v1/apps/${app.slug}/members/${users[person.key]}`, { org: ORG, plan: 'team', ...(role ? { role } : {}) });
      }
    }
    log(`members: ${TEAM.map((p) => `${p.name} (${p.role})`).join(', ')} in org ${ORG}`);

    // ---- grants and consents
    for (const g of GRANTS) {
      const { connected, calls, ...request } = g;
      const created = await call('builder', 'POST', '/v1/grants', request, [409]);
      if (created.status !== 201) continue;
      if (connected) await call('builder', 'POST', `/v1/grants/${created.body.grant.id}/allow`);
      if (calls > 0) await call('service', 'POST', '/internal/v1/grants/calls', { fromApp: g.fromApp, toApp: g.toApp, kind: g.kind, count: calls });
    }
    for (const c of CONSENTS) {
      await call('service', 'PUT', '/internal/v1/consents', { userId: users[c.user], app: c.app, clientId: c.clientId, clientName: c.clientName, scopes: c.scopes });
    }

    // ---- activity: after the consents, so each assistant call is tied to its connection
    const activity = buildActivity(users, new Date());
    const active = new Set((await pool.query<{ app: string }>('select distinct app from runs')).rows.map((r) => r.app));
    const runs = activity.runs.filter((r) => !active.has(r.app));
    const calls = activity.calls.filter((c) => !active.has(c.app));
    for (let i = 0; i < runs.length; i += INGEST_BATCH) await call('service', 'POST', '/internal/v1/runs', { runs: runs.slice(i, i + INGEST_BATCH) });
    for (let i = 0; i < calls.length; i += INGEST_BATCH) await call('service', 'POST', '/internal/v1/mcp-calls', { calls: calls.slice(i, i + INGEST_BATCH) });
    log(
      runs.length + calls.length > 0
        ? `activity: ${runs.length} runs and ${calls.length} assistant tool calls over the last ${ACTIVITY_DAYS} days`
        : 'activity: left as it is (the apps already have runs)',
    );

    await seedFeedback(database, users, builderId);
    await seedAppData(cfg, users);
    log(`data: ${FEEDBACK.length} feedback tickets, ${REPORTS.length} reports, ${BOARD.length + 1} board tickets, ${PROJECTS.length} projects, ${COMMENTS.length} comments`);
    return { builderId, users };
  } finally {
    await database.close();
    await pool.end();
  }
}

/**
 * Feedback tickets with the prototype's keys and states, and the reports the Self-Improvement agent
 * would have written about them. The routes number tickets themselves and ask the model for reports,
 * so these rows are inserted directly. An app that already has tickets is left alone.
 */
async function seedFeedback(database: Database, users: Record<TeamKey, string>, builderId: string): Promise<void> {
  const now = Date.now();
  // New feedback continues after the highest seeded key.
  for (const app of new Set(FEEDBACK.map((f) => f.app))) {
    const last = Math.max(...FEEDBACK.filter((f) => f.app === app).map((f) => Number(f.key.slice(3))));
    await database.pool.query('update apps set ticket_seq = greatest(ticket_seq, $1) where slug = $2', [last, app]);
  }
  await database.db.transaction(async (tx) => {
    for (const app of new Set(FEEDBACK.map((f) => f.app))) {
      const existing = await tx.query.tickets.findFirst({ where: (t, { eq }) => eq(t.app, app) });
      if (existing) continue;
      const items = FEEDBACK.filter((f) => f.app === app);
      for (const f of items) {
        const createdAt = new Date(now - f.ageHours * HOUR);
        const [ticket] = await tx
          .insert(control.tickets)
          .values({
            app,
            key: f.key,
            type: f.type,
            title: f.title,
            text: f.text,
            route: '/board',
            source: 'in-app',
            votes: f.votes,
            status: f.status,
            priority: f.priority,
            valid: true,
            reporter: users[f.reporter],
            reporterOrg: ORG,
            fixedIn: f.fixedIn ?? null,
            triagedAt: f.status === 'new' ? null : new Date(createdAt.getTime() + HOUR),
            createdAt,
            updatedAt: createdAt,
          })
          .returning();
        await tx.insert(control.ticketEvents).values([
          { ticketId: ticket!.id, kind: 'created', actor: users[f.reporter], data: { source: 'in-app', env: 'prod' }, createdAt },
          ...Array.from({ length: f.replies }, (_, i) => ({
            ticketId: ticket!.id,
            kind: 'reply',
            actor: builderId,
            data: { text: i === 0 ? `Thanks, we are tracking this as ${f.key}.` : f.fixedIn ? `Fixed in ${f.fixedIn}.` : 'Update: this is on the list for the next report.' },
            createdAt: new Date(createdAt.getTime() + (i + 1) * 20 * 60 * 1000),
          })),
        ]);
      }
      for (const r of REPORTS.filter((x) => x.app === app)) {
        const createdAt = new Date(now - r.ageHours * HOUR);
        const open = items.filter((f) => f.status !== 'done');
        const tally = (pick: (f: (typeof items)[number]) => string) =>
          open.reduce<Record<string, number>>((acc, f) => ({ ...acc, [pick(f)]: (acc[pick(f)] ?? 0) + 1 }), {});
        const [report] = await tx
          .insert(control.reports)
          .values({
            app,
            date: createdAt.toISOString().slice(0, 10),
            summary: r.summary,
            stats: {
              window: { from: new Date(createdAt.getTime() - DAY).toISOString(), to: createdAt.toISOString() },
              received: r.received,
              valid: r.valid,
              mergedOrNoise: r.received - r.valid,
              open: open.length,
              byType: tally((f) => f.type),
              byPriority: tally((f) => f.priority),
              metrics: {},
            },
            createdAt,
          })
          .returning();
        await tx.insert(control.proposals).values(
          r.proposals.map((p, i) => ({
            reportId: report!.id,
            app,
            position: i + 1,
            title: p.title,
            body: p.body,
            refs: p.refs,
            impact: p.impact,
            effort: p.effort,
            affects: p.affects,
            status: p.status,
            ...(p.status === 'built' ? { decidedBy: builderId, decidedAt: new Date(createdAt.getTime() + 12 * 60 * 1000) } : {}),
            createdAt,
          })),
        );
      }
    }
  });
}

/** Board rows in the app database, written as the database owner with fixed ids so a re-run adds nothing. */
async function seedAppData(cfg: StackConfig, users: Record<TeamKey, string>): Promise<void> {
  const inDays = (days: number) => new Date(Date.now() + days * DAY);
  await withClient(cfg.appDatabaseUrl, async (client) => {
    await client.query('begin');
    try {
      for (const p of PROJECTS) {
        await client.query(
          `insert into app.projects (id, org_id, owner_id, name, starts_on, ends_on) values ($1, $2, $3, $4, $5, $6) on conflict (id) do nothing`,
          [p.id, ORG, users.seoyeon, p.name, inDays(p.startsInDays), inDays(p.endsInDays)],
        );
      }
      for (const t of BOARD) {
        await client.query(
          `insert into app.tickets (id, org_id, owner_id, shared, title, status, assignee_id, due_on, project_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (id) do nothing`,
          [t.id, ORG, users[t.createdBy], t.shared, t.title, t.status, users[t.assignee], inDays(t.dueInDays), PROJECTS[t.project]!.id],
        );
      }
      await client.query(
        `insert into app.tickets (id, org_id, owner_id, shared, title, status, assignee_id) values ($1, $2, 'x', true, $3, 'todo', 'x') on conflict (id) do nothing`,
        [FOREIGN_TICKET.id, FOREIGN_TICKET.org, FOREIGN_TICKET.title],
      );
      for (const c of COMMENTS) {
        await client.query(
          `insert into app.comments (id, org_id, owner_id, ticket_id, body) values ($1, $2, $3, $4, $5) on conflict (id) do nothing`,
          [c.id, ORG, users[c.author], c.ticket, c.body],
        );
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    }
  });
}
