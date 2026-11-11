// Feedback intake and triage (docs/infrastructure.md §4.3): raw feedback → ticket (New) → classified,
// merged into a similar open ticket, or dropped as noise (Triaged).
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Executor } from '../db/client.ts';
import { apps, ticketEvents, tickets, type AppRow, type TicketRow, type TicketSource } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { TriageLabel } from '../llm/types.ts';

export interface NewFeedback {
  app: string;
  text: string;
  route?: string | null;
  context?: unknown;
  source: TicketSource;
  reporter?: string | null;
  reporterOrg?: string | null;
  /** Env of the app runtime that relayed it; dev feedback usually comes from the builder or named testers. */
  env?: 'dev' | 'prod';
}

const TITLE_MAX = 80;

export function draftTitle(text: string): string {
  const line = text.trim().split('\n')[0]?.replace(/\s+/g, ' ') ?? '';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

export async function createTicket(db: Executor, f: NewFeedback): Promise<TicketRow> {
  return db.transaction(async (tx) => {
    const [seq] = await tx
      .update(apps)
      .set({ ticketSeq: sql`${apps.ticketSeq} + 1` })
      .where(eq(apps.slug, f.app))
      .returning({ n: apps.ticketSeq });
    if (!seq) throw new Error(`app ${f.app} vanished while creating a ticket`);
    const [row] = await tx
      .insert(tickets)
      .values({
        app: f.app,
        key: `FB-${seq.n}`,
        title: draftTitle(f.text),
        text: f.text,
        route: f.route ?? null,
        context: f.context ?? null,
        source: f.source,
        reporter: f.reporter ?? null,
        reporterOrg: f.reporterOrg ?? null,
      })
      .returning();
    await tx.insert(ticketEvents).values({ ticketId: row!.id, kind: 'created', actor: f.reporter ?? null, data: { source: f.source, ...(f.env ? { env: f.env } : {}) } });
    return row!;
  });
}

export interface TriageOutcome {
  key: string;
  outcome: 'triaged' | 'duplicate' | 'noise' | 'failed' | 'skipped';
  duplicateOf?: string;
  similarity?: number;
  type?: string;
  priority?: string;
  error?: string;
}

export interface TriageSummary {
  processed: number;
  triaged: number;
  duplicates: number;
  noise: number;
  failed: number;
  tickets: TriageOutcome[];
}

/** Most similar earlier open ticket of the same app, if it clears the threshold. */
async function findDuplicate(db: Executor, t: TicketRow, threshold: number) {
  const res = await db.execute<{ id: string; key: string; score: number }>(sql`
    select id, key, greatest(similarity(text, ${t.text}), similarity(title, ${t.text}))::float8 as score
    from tickets
    where app = ${t.app} and id <> ${t.id}
      and duplicate_of is null and valid is not false
      and status in ('new', 'triaged', 'progress')
      and created_at <= ${t.createdAt}
      and greatest(similarity(text, ${t.text}), similarity(title, ${t.text})) >= ${threshold}
    order by score desc, created_at asc
    limit 1`);
  return res.rows[0] ?? null;
}

/** Triages New tickets oldest first, so later reports of the same problem merge into the earliest one. */
export async function triageApp(ctx: Ctx, app: AppRow, limit: number): Promise<TriageSummary> {
  const { db, llm, logger } = ctx;
  const pending = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.app, app.slug), eq(tickets.status, 'new'), isNull(tickets.triagedAt)))
    .orderBy(asc(tickets.createdAt), asc(tickets.key))
    .limit(limit);

  const summary: TriageSummary = { processed: 0, triaged: 0, duplicates: 0, noise: 0, failed: 0, tickets: [] };
  const stillNew = and(eq(tickets.status, 'new'), isNull(tickets.triagedAt));

  for (const t of pending) {
    summary.processed++;
    const dup = await findDuplicate(db, t, ctx.dedupeThreshold);
    if (dup) {
      const merged = await db.transaction(async (tx) => {
        const [original] = await tx.select().from(tickets).where(eq(tickets.id, dup.id));
        const [row] = await tx
          .update(tickets)
          .set({
            status: 'triaged',
            valid: true,
            duplicateOf: dup.id,
            type: original?.type ?? null,
            priority: original?.priority ?? null,
            triagedAt: ctx.now(),
            updatedAt: ctx.now(),
          })
          .where(and(eq(tickets.id, t.id), stillNew))
          .returning();
        if (!row) return false;
        await tx
          .update(tickets)
          .set({ votes: sql`${tickets.votes} + ${t.votes}`, updatedAt: ctx.now() })
          .where(eq(tickets.id, dup.id));
        await tx.insert(ticketEvents).values([
          { ticketId: t.id, kind: 'duplicate', actor: 'triage', data: { of: dup.key, similarity: dup.score } },
          { ticketId: dup.id, kind: 'vote', actor: t.reporter, data: { from: t.key, votes: t.votes } },
        ]);
        return true;
      });
      if (merged) {
        summary.duplicates++;
        summary.tickets.push({ key: t.key, outcome: 'duplicate', duplicateOf: dup.key, similarity: dup.score });
      } else {
        summary.tickets.push({ key: t.key, outcome: 'skipped' });
      }
      continue;
    }

    let label: TriageLabel;
    try {
      label = TriageLabel.parse(
        await llm.triage({ slug: app.slug, name: app.name, description: app.description }, { key: t.key, text: t.text, route: t.route, source: t.source }),
      );
    } catch (e) {
      const error = (e as Error).message;
      logger.warn({ type: 'triage_failed', app: app.slug, ticket: t.key, err: error }, 'triage failed');
      await db.insert(ticketEvents).values({ ticketId: t.id, kind: 'triage_failed', actor: 'triage', data: { error } });
      summary.failed++;
      summary.tickets.push({ key: t.key, outcome: 'failed', error });
      continue;
    }

    const [row] = await db.transaction(async (tx) => {
      const updated = await tx
        .update(tickets)
        .set({
          status: 'triaged',
          valid: label.valid,
          type: label.type,
          priority: label.priority,
          title: draftTitle(label.title) || t.title,
          triagedAt: ctx.now(),
          updatedAt: ctx.now(),
        })
        .where(and(eq(tickets.id, t.id), stillNew))
        .returning();
      if (updated[0]) {
        await tx.insert(ticketEvents).values({ ticketId: t.id, kind: label.valid ? 'triaged' : 'noise', actor: 'triage', data: { ...label } });
      }
      return updated;
    });
    if (!row) {
      summary.tickets.push({ key: t.key, outcome: 'skipped' });
    } else if (label.valid) {
      summary.triaged++;
      summary.tickets.push({ key: t.key, outcome: 'triaged', type: label.type, priority: label.priority });
    } else {
      summary.noise++;
      summary.tickets.push({ key: t.key, outcome: 'noise' });
    }
  }
  logger.info({ type: 'triage', app: app.slug, ...summary, tickets: undefined }, 'triage finished');
  return summary;
}
