// Routes for platform services (service caller token): the app registry (contract §6), membership upserts for
// Kelay ID, consent records, grant checks for the MCP · A2A gateway, intake from other channels, and the
// improvement-run worker protocol.
import { Hono } from 'hono';
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppRegistryEntry, AppSlug, Ident, type AppList } from '@kelay/contracts';
import { BUILDER_ROLES, CONSOLE_APP, requireService, type AppEnv } from '../auth.ts';
import { appMembers, apps, consents, envs, ENV_NAMES, GRANT_KINDS, grants, sandboxes, TICKET_SOURCES, versions } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { claimRun, completeRun } from '../queue/improvement.ts';
import { createTicket } from '../services/feedback.ts';
import { declaredRoles } from './apps.ts';
import { consentView } from './consents.ts';
import { FeedbackBody } from './feedback.ts';
import { grantView } from './grants.ts';
import { jsonBody, queryParams } from './util.ts';

const EnvParam = z.enum(ENV_NAMES);

/** `member` when the app declares it (or has no schema yet), else its first role other than admin. */
export function defaultRole(roles: string[] | null): string {
  if (!roles || roles.includes('member')) return 'member';
  return roles.find((r) => r !== 'admin') ?? roles[0] ?? 'member';
}

const UpsertMember = z.object({
  org: z.string().min(1).max(200),
  role: Ident.optional(),
  plan: Ident.optional(),
  status: z.enum(['active', 'unconfirmed']).optional(),
});

const UpsertConsent = z.object({
  userId: z.string().min(1),
  app: AppSlug,
  clientId: z.url(),
  clientName: z.string().max(200).optional(),
  scopes: z.array(z.string().max(200)).max(100),
});

const IntakeBody = FeedbackBody.extend({
  source: z.enum(TICKET_SOURCES.filter((s) => s !== 'in-app') as ['email', 'chat', 'auto']),
  reporter: z.string().optional(),
  reporterOrg: z.string().optional(),
});

const SandboxRecord = z.object({
  /** The ECS task ARN, or `local:<dir>` for a workspace on the Builder's own machine. */
  taskArn: z.string().min(1).max(2048),
  owner: z.string().min(1).max(200),
  app: AppSlug,
  kind: z.enum(['workspace', 'improvement']),
  status: z.enum(['running', 'stopped']),
});

const RunOutcome = z.object({
  status: z.enum(['succeeded', 'failed']),
  branch: z.string().max(200).optional(),
  versionId: z.uuid().optional(),
  error: z.string().max(5000).optional(),
});

export function internalRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const { db } = ctx;
  r.use('/internal/*', requireService(ctx.auth));

  const liveApp = async (slug: string) => {
    const app = await db.query.apps.findFirst({ where: eq(apps.slug, slug) });
    if (!app || app.status === 'archived') throw new ApiError('unknown_app', `unknown app ${slug}`);
    return app;
  };

  // What the HTTP app registry lists (contract §6): the apps `GET /internal/v1/apps/:app` would answer for.
  r.get('/internal/v1/apps', queryParams(z.object({ env: EnvParam.optional() })), async (c) => {
    const rows = await db
      .select({ app: apps.slug, handle: apps.handle })
      .from(apps)
      .innerJoin(envs, and(eq(envs.app, apps.slug), eq(envs.name, c.req.valid('query').env ?? 'prod')))
      .innerJoin(versions, eq(versions.id, envs.activeVersionId))
      .where(and(ne(apps.status, 'archived'), isNotNull(envs.databaseUrl), isNotNull(versions.schema)))
      .orderBy(apps.slug);
    return c.json({ apps: rows } satisfies AppList);
  });

  r.get('/internal/v1/apps/:app', queryParams(z.object({ env: EnvParam.optional() })), async (c) => {
    const app = await liveApp(c.req.param('app'));
    const env = c.req.valid('query').env ?? 'prod';
    const [row] = await db
      .select({ databaseUrl: envs.databaseUrl, schema: versions.schema, policy: versions.policy })
      .from(envs)
      .leftJoin(versions, eq(versions.id, envs.activeVersionId))
      .where(and(eq(envs.app, app.slug), eq(envs.name, env)));
    if (!row?.databaseUrl || !row.schema) throw new ApiError('unknown_app', `app ${app.slug} has no ${env} deployment with a database`);
    const entry: AppRegistryEntry = AppRegistryEntry.parse({
      handle: app.handle,
      databaseUrl: row.databaseUrl,
      schema: row.schema,
      ...(row.policy ? { policy: row.policy } : {}),
    });
    return c.json(entry);
  });

  r.put('/internal/v1/apps/:app/envs/:env', jsonBody(z.object({ databaseUrl: z.string().min(1) })), async (c) => {
    const app = await liveApp(c.req.param('app'));
    const env = EnvParam.safeParse(c.req.param('env'));
    if (!env.success) throw new ApiError('invalid_request', 'env must be dev or prod');
    await db
      .update(envs)
      .set({ databaseUrl: c.req.valid('json').databaseUrl, updatedAt: ctx.now() })
      .where(and(eq(envs.app, app.slug), eq(envs.name, env.data)));
    return c.json({ app: app.slug, env: env.data, hasDatabase: true });
  });

  // Kelay ID and the Builder call this, so app_members has a single writer. The console is not an app
  // row, yet its builders are members of `kelay-console`: that slug takes the builder roles only.
  r.put('/internal/v1/apps/:app/members/:userId', jsonBody(UpsertMember), async (c) => {
    const body = c.req.valid('json');
    const slug = c.req.param('app') === CONSOLE_APP ? CONSOLE_APP : (await liveApp(c.req.param('app'))).slug;
    if (slug === CONSOLE_APP && body.role && !BUILDER_ROLES.includes(body.role)) {
      throw new ApiError('invalid_request', `role must be one of ${BUILDER_ROLES.join(', ')}`);
    }
    const [member] = await db
      .insert(appMembers)
      .values({
        app: slug,
        userId: c.req.param('userId'),
        org: body.org,
        role: body.role ?? (slug === CONSOLE_APP ? 'builder' : defaultRole(await declaredRoles(db, slug))),
        plan: body.plan ?? 'free',
        status: body.status ?? 'active',
      })
      .onConflictDoUpdate({
        target: [appMembers.app, appMembers.userId],
        set: {
          org: body.org,
          ...(body.role ? { role: body.role } : {}),
          ...(body.plan ? { plan: body.plan } : {}),
          // A banned member stays banned; only the builder can unban.
          status: sql`case when ${appMembers.status} = 'banned' then 'banned' else ${body.status ?? 'active'} end`,
        },
      })
      .returning();
    return c.json({ member });
  });

  r.post('/internal/v1/apps/:app/feedback', jsonBody(IntakeBody), async (c) => {
    const app = await liveApp(c.req.param('app'));
    const body = c.req.valid('json');
    const ticket = await createTicket(db, {
      app: app.slug,
      text: body.text,
      route: body.route ?? null,
      context: body.context ?? null,
      source: body.source,
      reporter: body.reporter ?? null,
      reporterOrg: body.reporterOrg ?? null,
    });
    return c.json({ ticketId: ticket.key }, 201);
  });

  r.put('/internal/v1/consents', jsonBody(UpsertConsent), async (c) => {
    const body = c.req.valid('json');
    await liveApp(body.app);
    const consent = await db.transaction(async (tx) => {
      const [current] = await tx
        .update(consents)
        .set({ scopes: body.scopes, ...(body.clientName ? { clientName: body.clientName } : {}) })
        .where(and(eq(consents.userId, body.userId), eq(consents.app, body.app), eq(consents.clientId, body.clientId), isNull(consents.revokedAt)))
        .returning();
      if (current) return current;
      const [created] = await tx.insert(consents).values({ ...body, clientName: body.clientName ?? null }).returning();
      return created!;
    });
    return c.json({ consent: consentView(consent) });
  });

  r.get('/internal/v1/consents/check', queryParams(z.object({ userId: z.string().min(1), app: AppSlug, clientId: z.string().min(1) })), async (c) => {
    const q = c.req.valid('query');
    const row = await db.query.consents.findFirst({
      where: and(eq(consents.userId, q.userId), eq(consents.app, q.app), eq(consents.clientId, q.clientId), isNull(consents.revokedAt)),
    });
    if (row) await db.update(consents).set({ lastUsedAt: ctx.now() }).where(eq(consents.id, row.id));
    return c.json({ active: !!row, consent: row ? consentView(row) : null });
  });

  r.get('/internal/v1/grants', queryParams(z.object({ fromApp: AppSlug, toApp: AppSlug, kind: z.enum(GRANT_KINDS).optional() })), async (c) => {
    const q = c.req.valid('query');
    const rows = await db
      .select()
      .from(grants)
      .where(and(eq(grants.fromApp, q.fromApp), eq(grants.toApp, q.toApp), q.kind ? eq(grants.kind, q.kind) : undefined, ne(grants.status, 'rejected')));
    return c.json({ connected: rows.some((g) => g.status === 'connected'), grants: rows.map((g) => grantView(g)) });
  });

  r.post(
    '/internal/v1/grants/calls',
    jsonBody(z.object({ fromApp: AppSlug, toApp: AppSlug, kind: z.enum(GRANT_KINDS), count: z.number().int().min(1).max(1_000_000).default(1) })),
    async (c) => {
      const b = c.req.valid('json');
      const rows = await db
        .update(grants)
        .set({ calls: sql`${grants.calls} + ${b.count}` })
        .where(and(eq(grants.fromApp, b.fromApp), eq(grants.toApp, b.toApp), eq(grants.kind, b.kind), eq(grants.status, 'connected')))
        .returning({ id: grants.id, calls: grants.calls });
      if (rows.length === 0) throw new ApiError('denied', 'no connected grant for this link');
      return c.json({ grant: rows[0] });
    },
  );

  // The Builder reports each workspace it starts, uses and stops, so `sandboxes` says what is running for whom.
  r.put('/internal/v1/sandboxes', jsonBody(SandboxRecord), async (c) => {
    const body = c.req.valid('json');
    await liveApp(body.app);
    const [sandbox] = await db
      .insert(sandboxes)
      .values({ ...body, lastActive: ctx.now() })
      .onConflictDoUpdate({ target: sandboxes.taskArn, set: { owner: body.owner, app: body.app, kind: body.kind, status: body.status, lastActive: ctx.now() } })
      .returning();
    return c.json({ sandbox });
  });

  r.post('/internal/v1/improvement-runs/claim', jsonBody(z.object({ worker: z.string().min(1).max(200), app: AppSlug.optional() })), async (c) => {
    const b = c.req.valid('json');
    const run = await claimRun(db, b.worker, b.app);
    if (!run) return c.body(null, 204);
    const proposal = await db.query.proposals.findFirst({ where: (p, { eq: is }) => is(p.id, run.proposalId) });
    return c.json({ run, proposal });
  });

  r.post('/internal/v1/improvement-runs/:id/complete', jsonBody(RunOutcome), async (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw new ApiError('not_found', 'no such run');
    const run = await completeRun(db, id, c.req.valid('json'));
    if (!run) throw new ApiError('conflict', 'run is not running');
    return c.json({ run });
  });

  return r;
}
