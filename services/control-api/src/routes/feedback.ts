// /feedback intake (end users through the SDK) and the builder's ticket board.
import { Hono } from 'hono';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, count, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireAppUser, requireBuilder, requireBuilderOrService, type AppEnv } from '../auth.ts';
import {
  appMembers,
  apps,
  PRIORITIES,
  TICKET_SOURCES,
  TICKET_STATUSES,
  TICKET_TYPES,
  ticketEvents,
  tickets,
  type TicketRow,
} from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { createTicket, triageApp } from '../services/feedback.ts';
import { actorOf, jsonBody, loadApp, queryParams, ticketView } from './util.ts';

export const FeedbackBody = z.object({
  text: z.string().trim().min(1).max(5000),
  route: z.string().max(500).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const TicketQuery = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  type: z.enum(TICKET_TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  source: z.enum(TICKET_SOURCES).optional(),
  q: z.string().max(200).optional(),
  /** `all` also returns noise and merged duplicates. */
  include: z.enum(['open', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const PatchTicket = z
  .object({
    status: z.enum(TICKET_STATUSES),
    type: z.enum(TICKET_TYPES),
    priority: z.enum(PRIORITIES),
    title: z.string().trim().min(1).max(200),
    valid: z.boolean(),
    fixedIn: z.string().max(40).nullable(),
    /** Merge this ticket into another one of the same app (its votes move over). */
    duplicateOf: z.string().regex(/^FB-\d+$/),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'nothing to change');

const TriageBody = z.object({ limit: z.number().int().min(1).max(200).optional() }).optional();

const original = alias(tickets, 'original');

export function feedbackRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const { db } = ctx;
  const builder = requireBuilder(ctx.auth);

  r.post('/v1/apps/:app/feedback', requireAppUser(ctx.auth), jsonBody(FeedbackBody), async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'user') throw new ApiError('denied', 'end-user access required');
    const slug = c.req.param('app');
    const app = await db.query.apps.findFirst({ where: eq(apps.slug, slug) });
    if (!app || app.status === 'archived') throw new ApiError('unknown_app', `unknown app ${slug}`);
    const member = await db.query.appMembers.findFirst({ where: and(eq(appMembers.app, slug), eq(appMembers.userId, p.user.sub)) });
    if (member?.status === 'banned') throw new ApiError('denied', 'this account is banned from the app');
    const body = c.req.valid('json');
    const ticket = await createTicket(db, {
      app: slug,
      text: body.text,
      route: body.route ?? null,
      context: body.context ?? null,
      source: 'in-app',
      reporter: p.user.sub,
      reporterOrg: p.user.org,
    });
    ctx.logger.info({ type: 'feedback', app: slug, ticket: ticket.key, sub: p.user.sub }, 'feedback received');
    return c.json({ ticketId: ticket.key }, 201);
  });

  r.get('/v1/apps/:app/tickets', builder, queryParams(TicketQuery), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const q = c.req.valid('query');
    const like = q.q ? `%${q.q.replace(/[%_\\]/g, '\\$&')}%` : null;
    const where = and(
      eq(tickets.app, app.slug),
      q.status ? eq(tickets.status, q.status) : undefined,
      q.type ? eq(tickets.type, q.type) : undefined,
      q.priority ? eq(tickets.priority, q.priority) : undefined,
      q.source ? eq(tickets.source, q.source) : undefined,
      q.include === 'all' ? undefined : and(isNull(tickets.duplicateOf), or(isNull(tickets.valid), eq(tickets.valid, true))),
      like ? or(ilike(tickets.title, like), ilike(tickets.text, like), eq(tickets.key, q.q!.toUpperCase())) : undefined,
    );
    const rows = await db
      .select({
        ticket: tickets,
        duplicateOfKey: original.key,
        replies: sql<number>`(select count(*)::int from ticket_events e where e.ticket_id = ${tickets.id} and e.kind = 'reply')`,
      })
      .from(tickets)
      .leftJoin(original, eq(original.id, tickets.duplicateOf))
      .where(where)
      .orderBy(desc(tickets.createdAt))
      .limit(q.limit ?? 200)
      .offset(q.offset ?? 0);
    const [total] = await db.select({ n: count() }).from(tickets).where(where);
    return c.json({ tickets: rows.map((row) => ticketView(row.ticket, row)), total: total?.n ?? 0 });
  });

  const findTicket = async (app: string, key: string): Promise<TicketRow> => {
    const t = await db.query.tickets.findFirst({ where: and(eq(tickets.app, app), eq(tickets.key, key)) });
    if (!t) throw new ApiError('not_found', `no ticket ${key}`);
    return t;
  };

  r.get('/v1/apps/:app/tickets/:key', builder, async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const t = await findTicket(app.slug, c.req.param('key'));
    const [events, dups, of] = await Promise.all([
      db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, t.id)).orderBy(asc(ticketEvents.createdAt)),
      db.select({ key: tickets.key }).from(tickets).where(eq(tickets.duplicateOf, t.id)).orderBy(asc(tickets.createdAt)),
      t.duplicateOf ? db.select({ key: tickets.key }).from(tickets).where(eq(tickets.id, t.duplicateOf)) : Promise.resolve([]),
    ]);
    const replies = events.filter((e) => e.kind === 'reply').length;
    return c.json({ ticket: ticketView(t, { replies, duplicateOfKey: of[0]?.key ?? null }), events, duplicates: dups.map((d) => d.key) });
  });

  r.patch('/v1/apps/:app/tickets/:key', builder, jsonBody(PatchTicket), async (c) => {
    const principal = c.get('principal');
    const app = await loadApp(db, c.req.param('app'), principal);
    const body = c.req.valid('json');
    const actor = actorOf(principal);
    const t = await findTicket(app.slug, c.req.param('key'));
    const updated = await db.transaction(async (tx) => {
      const { duplicateOf, ...fields } = body;
      let duplicateOfId: string | undefined;
      if (duplicateOf) {
        const target = await tx.query.tickets.findFirst({ where: and(eq(tickets.app, app.slug), eq(tickets.key, duplicateOf)) });
        if (!target) throw new ApiError('not_found', `no ticket ${duplicateOf}`);
        if (target.id === t.id || target.duplicateOf) throw new ApiError('invalid_request', 'merge into an open ticket that is not itself merged');
        if (t.duplicateOf) throw new ApiError('conflict', `${t.key} is already merged`);
        duplicateOfId = target.id;
        await tx.update(tickets).set({ votes: sql`${tickets.votes} + ${t.votes}`, updatedAt: ctx.now() }).where(eq(tickets.id, target.id));
        await tx.update(tickets).set({ duplicateOf: null }).where(eq(tickets.duplicateOf, t.id));
        await tx.insert(ticketEvents).values({ ticketId: target.id, kind: 'vote', actor, data: { from: t.key, votes: t.votes } });
      }
      const [row] = await tx
        .update(tickets)
        .set({
          ...fields,
          ...(duplicateOfId ? { duplicateOf: duplicateOfId } : {}),
          ...(fields.status && fields.status !== 'new' && !t.triagedAt ? { triagedAt: ctx.now() } : {}),
          updatedAt: ctx.now(),
        })
        .where(eq(tickets.id, t.id))
        .returning();
      await tx.insert(ticketEvents).values({ ticketId: t.id, kind: duplicateOf ? 'duplicate' : 'updated', actor, data: { ...body } });
      return row!;
    });
    return c.json({ ticket: ticketView(updated, { duplicateOfKey: body.duplicateOf ?? null }) });
  });

  r.post('/v1/apps/:app/tickets/:key/replies', builder, jsonBody(z.object({ text: z.string().trim().min(1).max(5000) })), async (c) => {
    const principal = c.get('principal');
    const app = await loadApp(db, c.req.param('app'), principal);
    const t = await findTicket(app.slug, c.req.param('key'));
    const [event] = await db
      .insert(ticketEvents)
      .values({ ticketId: t.id, kind: 'reply', actor: actorOf(principal), data: { text: c.req.valid('json').text } })
      .returning();
    return c.json({ event }, 201);
  });

  r.post('/v1/apps/:app/tickets/triage', requireBuilderOrService(ctx.auth), jsonBody(TriageBody), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const summary = await triageApp(ctx, app, c.req.valid('json')?.limit ?? 50);
    return c.json(summary);
  });

  return r;
}
