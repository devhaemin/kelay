// Builder routes: apps CRUD and per-app membership (the Users tab).
import { Hono } from 'hono';
import { and, asc, eq, getTableColumns, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppSlug, Ident } from '@kelay/contracts';
import { requireBuilder, type AppEnv } from '../auth.ts';
import type { Executor } from '../db/client.ts';
import { appMembers, apps, builders, envs, versions, ENV_NAMES, type AppRow, type MemberRow } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { ApiError, isUniqueViolation } from '../errors.ts';
import { loadProfiles, NO_PROFILE } from '../services/profiles.ts';
import { appView, jsonBody, loadApp, queryParams, versionView } from './util.ts';

const CreateApp = z.object({
  slug: AppSlug,
  name: z.string().trim().min(1).max(120),
  /** Required for a builder's first app; afterwards it must match the builder's handle. */
  handle: AppSlug.optional(),
  description: z.string().max(2000).optional(),
  emoji: z.string().max(16).optional(),
  color: z.string().max(32).optional(),
  listed: z.boolean().optional(),
});

const PatchApp = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    emoji: z.string().max(16).nullable(),
    color: z.string().max(32).nullable(),
    listed: z.boolean(),
    status: z.enum(['draft', 'live', 'paused']),
  })
  .partial();

const MemberQuery = z.object({
  status: z.enum(['active', 'unconfirmed', 'banned']).optional(),
  role: Ident.optional(),
  org: z.string().optional(),
  q: z.string().max(200).optional(),
});

const PatchMember = z
  .object({
    role: Ident,
    plan: Ident,
    org: z.string().min(1).max(200),
    /** `banned` bans, `active` unbans. */
    status: z.enum(['active', 'banned']),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'nothing to change');

export function databaseUrlFor(template: string | undefined, app: string, env: string): string | null {
  if (!template) return null;
  return template.replaceAll('{app}', app.replaceAll('-', '_')).replaceAll('{env}', env);
}

/** Roles the app declares in its deployed schema (prod first), or null before the first deploy. */
export async function declaredRoles(db: Executor, app: string): Promise<string[] | null> {
  const rows = await db
    .select({ env: envs.name, schema: versions.schema })
    .from(envs)
    .innerJoin(versions, eq(versions.id, envs.activeVersionId))
    .where(eq(envs.app, app));
  const pick = rows.find((r) => r.env === 'prod' && r.schema) ?? rows.find((r) => r.schema);
  return pick?.schema?.roles ?? null;
}

export function appRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const builder = requireBuilder(ctx.auth);
  const { db } = ctx;

  /** app_members rows with the person's Kelay ID profile; the profile fields are null for an id Kelay ID does not know. */
  const withProfiles = async (rows: MemberRow[]) => {
    const profiles = await loadProfiles(db, rows.map((m) => m.userId));
    return rows.map((m) => ({ ...m, ...(profiles.get(m.userId) ?? NO_PROFILE) }));
  };

  r.get('/v1/apps', builder, async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'builder') throw new ApiError('denied', 'builder access required');
    const rows = await db
      .select({
        ...getTableColumns(apps),
        members: sql<number>`(select count(*)::int from app_members m where m.app = ${apps.slug})`,
        newFeedback: sql<number>`(select count(*)::int from tickets t where t.app = ${apps.slug} and t.status = 'new' and t.duplicate_of is null and t.valid is not false)`,
        pendingProposals: sql<number>`(select count(*)::int from proposals pr where pr.app = ${apps.slug} and pr.status = 'pending')`,
        runs: sql<number | null>`(select nullif(count(*), 0)::int from runs r where r.app = ${apps.slug} and r.at >= now() - interval '30 days')`,
      })
      .from(apps)
      .where(and(eq(apps.owner, p.user.sub), ne(apps.status, 'archived')))
      .orderBy(asc(apps.createdAt));
    return c.json({
      apps: rows.map((a) => ({ ...appView(a), members: a.members, newFeedback: a.newFeedback, pendingProposals: a.pendingProposals, runs: a.runs })),
    });
  });

  r.post('/v1/apps', builder, jsonBody(CreateApp), async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'builder') throw new ApiError('denied', 'builder access required');
    const body = c.req.valid('json');
    const app = await db.transaction(async (tx) => {
      let me = await tx.query.builders.findFirst({ where: eq(builders.userId, p.user.sub) });
      if (!me) {
        if (!body.handle) throw new ApiError('invalid_request', 'handle is required for your first app');
        try {
          [me] = await tx.insert(builders).values({ userId: p.user.sub, handle: body.handle }).returning();
        } catch (e) {
          if (isUniqueViolation(e)) throw new ApiError('conflict', `handle ${body.handle} is taken`);
          throw e;
        }
      } else if (body.handle && body.handle !== me.handle) {
        throw new ApiError('conflict', `your handle is ${me.handle}`);
      }
      let row: AppRow | undefined;
      try {
        [row] = await tx
          .insert(apps)
          .values({
            slug: body.slug,
            handle: me!.handle,
            owner: p.user.sub,
            name: body.name,
            description: body.description ?? '',
            emoji: body.emoji ?? null,
            color: body.color ?? null,
            listed: body.listed ?? true,
          })
          .returning();
      } catch (e) {
        if (isUniqueViolation(e)) throw new ApiError('conflict', `app ${body.slug} already exists`);
        throw e;
      }
      await tx.insert(envs).values(ENV_NAMES.map((name) => ({ app: body.slug, name, databaseUrl: databaseUrlFor(ctx.databaseUrlTemplate, body.slug, name) })));
      return row!;
    });
    ctx.logger.info({ type: 'app_created', app: app.slug, owner: app.owner }, 'app created');
    return c.json({ app: appView(app) }, 201);
  });

  r.get('/v1/apps/:app', builder, async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const rows = await db
      .select({ env: envs, version: versions })
      .from(envs)
      .leftJoin(versions, eq(versions.id, envs.activeVersionId))
      .where(eq(envs.app, app.slug))
      .orderBy(asc(envs.name));
    return c.json({
      app: appView(app),
      envs: rows.map(({ env, version }) => ({
        name: env.name,
        hasDatabase: env.databaseUrl != null,
        activeVersion: version ? versionView(version) : null,
        updatedAt: env.updatedAt,
      })),
    });
  });

  r.patch('/v1/apps/:app', builder, jsonBody(PatchApp), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const [row] = await db
      .update(apps)
      .set({ ...c.req.valid('json'), updatedAt: ctx.now() })
      .where(eq(apps.slug, app.slug))
      .returning();
    return c.json({ app: appView(row!) });
  });

  // Archive instead of delete: the slug stays reserved because tokens and app databases carry it.
  r.delete('/v1/apps/:app', builder, async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const [row] = await db
      .update(apps)
      .set({ status: 'archived', listed: false, updatedAt: ctx.now() })
      .where(eq(apps.slug, app.slug))
      .returning();
    ctx.logger.info({ type: 'app_archived', app: app.slug }, 'app archived');
    // An archived app is no longer served. Its functions stay, so publishing again brings it back.
    await ctx.routes.delete(app.handle, app.slug).catch((e: Error) => ctx.logger.error({ type: 'route_delete_failed', app: app.slug, err: e.message }, 'the route of an archived app was not removed'));
    return c.json({ app: appView(row!) });
  });

  r.get('/v1/apps/:app/members', builder, queryParams(MemberQuery), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const q = c.req.valid('query');
    const where = and(
      eq(appMembers.app, app.slug),
      q.status ? eq(appMembers.status, q.status) : undefined,
      q.role ? eq(appMembers.role, q.role) : undefined,
      q.org ? eq(appMembers.org, q.org) : undefined,
    );
    // `q` matches the name and email as well as the user id, and those come from Kelay ID's tables.
    const needle = q.q?.trim().toLowerCase();
    const members = (await withProfiles(await db.select().from(appMembers).where(where).orderBy(asc(appMembers.userId)))).filter(
      (m) => !needle || [m.userId, m.name, m.email].some((v) => v?.toLowerCase().includes(needle)),
    );
    const [counts] = await db
      .select({
        all: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${appMembers.status} = 'active')::int`,
        unconfirmed: sql<number>`count(*) filter (where ${appMembers.status} = 'unconfirmed')::int`,
        banned: sql<number>`count(*) filter (where ${appMembers.status} = 'banned')::int`,
        admin: sql<number>`count(*) filter (where ${appMembers.role} = 'admin')::int`,
      })
      .from(appMembers)
      .where(eq(appMembers.app, app.slug));
    return c.json({ members, counts });
  });

  r.patch('/v1/apps/:app/members/:userId', builder, jsonBody(PatchMember), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const body = c.req.valid('json');
    if (body.role) {
      const roles = await declaredRoles(db, app.slug);
      if (roles && !roles.includes(body.role)) throw new ApiError('invalid_request', `role must be one of ${roles.join(', ')}`);
    }
    const [member] = await db
      .update(appMembers)
      .set(body)
      .where(and(eq(appMembers.app, app.slug), eq(appMembers.userId, c.req.param('userId'))))
      .returning();
    if (!member) throw new ApiError('not_found', 'no such member');
    ctx.logger.info({ type: 'member_updated', app: app.slug, user: member.userId, changes: Object.keys(body) }, 'member updated');
    return c.json({ member: (await withProfiles([member]))[0] });
  });

  r.delete('/v1/apps/:app/members/:userId', builder, async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const deleted = await db
      .delete(appMembers)
      .where(and(eq(appMembers.app, app.slug), eq(appMembers.userId, c.req.param('userId'))))
      .returning({ userId: appMembers.userId });
    if (deleted.length === 0) throw new ApiError('not_found', 'no such member');
    return c.json({ deleted: true });
  });

  return r;
}
