// App-to-app links for the App Graph (docs/infrastructure.md §4.4). The source app's owner requests a link;
// the target app's owner allows or rejects it, since the target's data is what the link opens up.
// The graph's own numbers (people, calls a day) are counted from app_members and runs.
import { Hono } from 'hono';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
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

const DAY_MS = 24 * 60 * 60 * 1000;

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
    const dayAgo = new Date(ctx.now().getTime() - DAY_MS).toISOString();
    const rows = await db
      .select({
        grant: grants,
        fromName: fromApps.name,
        toName: toApps.name,
        // Runs record the calling app, not the protocol, so an MCP and an A2A link between the same two apps share this count.
        callsPerDay: sql<number>`(select count(*)::int from runs r where r.app = ${grants.toApp} and r.caller_kind = 'app' and r.caller_id = ${grants.fromApp} and r.at >= ${dayAgo}::timestamptz)`,
      })
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
    return c.json({ grants: rows.map((row) => ({ ...grantView(row.grant, row), callsPerDay: row.callsPerDay })) });
  });

  // The App Graph's totals over every app the builder owns.
  r.get('/v1/graph/overview', builder, async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'builder') throw new ApiError('denied', 'builder access required');
    const owner = p.user.sub;
    const now = ctx.now().getTime();
    const ago = (days: number) => new Date(now - days * DAY_MS).toISOString();

    const people = await db.execute<{ people: number; multi: number }>(sql`
      select count(*)::int as people, count(*) filter (where n >= 2)::int as multi
      from (
        select m.user_id, count(*) as n
        from app_members m join apps a on a.slug = m.app
        where a.owner = ${owner} and a.status <> 'archived' and m.status <> 'banned'
        group by m.user_id
      ) as per_person`);

    // Calls that crossed an app boundary: from another app, or from a member's assistant.
    const calls = await db.execute<{ app: string; caller_kind: string; today: number; week: number; week_before: number }>(sql`
      select r.app, r.caller_kind,
        count(*) filter (where r.at >= ${ago(1)}::timestamptz)::int as today,
        count(*) filter (where r.at >= ${ago(7)}::timestamptz)::int as week,
        count(*) filter (where r.at < ${ago(7)}::timestamptz)::int as week_before
      from runs r join apps a on a.slug = r.app
      where a.owner = ${owner} and a.status <> 'archived' and r.caller_kind in ('app', 'agent') and r.at >= ${ago(14)}::timestamptz
      group by r.app, r.caller_kind`);
    const sum = (pick: (row: (typeof calls.rows)[number]) => number) => calls.rows.reduce((total, row) => total + pick(row), 0);
    const week = sum((row) => row.week);
    const weekBefore = sum((row) => row.week_before);

    return c.json({
      overview: {
        people: people.rows[0]?.people ?? 0,
        multiAppPeople: people.rows[0]?.multi ?? 0,
        callsPerDay: sum((row) => row.today),
        callsDeltaPct: weekBefore === 0 ? null : Math.round(((week - weekBefore) / weekBefore) * 100),
        agentCallsPerDay: Object.fromEntries(calls.rows.filter((row) => row.caller_kind === 'agent' && row.today > 0).map((row) => [row.app, row.today])),
      },
    });
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
