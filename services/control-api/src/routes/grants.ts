// App-to-app links for the App Graph (docs/infrastructure.md §4.4). The source app's owner requests a link;
// the target app's owner allows or rejects it, since the target's data is what the link opens up.
import { Hono } from 'hono';
import { and, desc, eq, inArray, ne, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { AppSlug } from '@kelay/contracts';
import { requireBuilder, type AppEnv, type Principal } from '../auth.ts';
import { apps, GRANT_KINDS, GRANT_STATUSES, grants, type GrantRow } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { ApiError, isUniqueViolation } from '../errors.ts';
import { actorOf, jsonBody, loadApp, queryParams } from './util.ts';

const RequestGrant = z.object({
  fromApp: AppSlug,
  toApp: AppSlug,
  kind: z.enum(GRANT_KINDS),
  purpose: z.string().trim().min(1).max(500),
});

const GrantQuery = z.object({ app: AppSlug.optional(), status: z.enum(GRANT_STATUSES).optional() });

const fromApps = alias(apps, 'from_apps');
const toApps = alias(apps, 'to_apps');

export function grantView(g: GrantRow, names?: { fromName: string | null; toName: string | null }) {
  return { ...g, fromName: names?.fromName ?? null, toName: names?.toName ?? null };
}

export function grantRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const { db } = ctx;
  const builder = requireBuilder(ctx.auth);

  r.get('/v1/grants', builder, queryParams(GrantQuery), async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'builder') throw new ApiError('denied', 'builder access required');
    const q = c.req.valid('query');
    const mine = db.select({ slug: apps.slug }).from(apps).where(and(eq(apps.owner, p.user.sub), ne(apps.status, 'archived')));
    const rows = await db
      .select({ grant: grants, fromName: fromApps.name, toName: toApps.name })
      .from(grants)
      .innerJoin(fromApps, eq(fromApps.slug, grants.fromApp))
      .innerJoin(toApps, eq(toApps.slug, grants.toApp))
      .where(
        and(
          or(inArray(grants.fromApp, mine), inArray(grants.toApp, mine)),
          q.app ? or(eq(grants.fromApp, q.app), eq(grants.toApp, q.app)) : undefined,
          q.status ? eq(grants.status, q.status) : ne(grants.status, 'rejected'),
        ),
      )
      .orderBy(desc(grants.createdAt));
    return c.json({ grants: rows.map((row) => grantView(row.grant, row)) });
  });

  r.post('/v1/grants', builder, jsonBody(RequestGrant), async (c) => {
    const principal = c.get('principal');
    const body = c.req.valid('json');
    if (body.fromApp === body.toApp) throw new ApiError('invalid_request', 'an app cannot link to itself');
    await loadApp(db, body.fromApp, principal);
    const target = await db.query.apps.findFirst({ where: eq(apps.slug, body.toApp) });
    if (!target || target.status === 'archived') throw new ApiError('unknown_app', `unknown app ${body.toApp}`);
    try {
      const [grant] = await db
        .insert(grants)
        .values({ ...body, requestedBy: actorOf(principal) })
        .returning();
      ctx.logger.info({ type: 'grant_requested', grant: grant!.id, from: body.fromApp, to: body.toApp, kind: body.kind }, 'grant requested');
      return c.json({ grant: grantView(grant!) }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError('conflict', `a ${body.kind} link from ${body.fromApp} to ${body.toApp} already exists`);
      throw e;
    }
  });

  const decide = async (principal: Principal, id: string, status: 'connected' | 'rejected') => {
    if (!z.uuid().safeParse(id).success) throw new ApiError('not_found', 'no such grant');
    const g = await db.query.grants.findFirst({ where: eq(grants.id, id) });
    if (!g) throw new ApiError('not_found', 'no such grant');
    await loadApp(db, g.toApp, principal);
    const [row] = await db
      .update(grants)
      .set({ status, decidedBy: actorOf(principal), decidedAt: ctx.now() })
      .where(and(eq(grants.id, id), eq(grants.status, 'pending')))
      .returning();
    if (!row) throw new ApiError('conflict', `grant is already ${g.status}`);
    ctx.logger.info({ type: 'grant_decided', grant: id, status }, 'grant decided');
    return row;
  };

  r.post('/v1/grants/:id/allow', builder, async (c) => c.json({ grant: grantView(await decide(c.get('principal'), c.req.param('id'), 'connected')) }));
  r.post('/v1/grants/:id/reject', builder, async (c) => c.json({ grant: grantView(await decide(c.get('principal'), c.req.param('id'), 'rejected')) }));

  return r;
}
