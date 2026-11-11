// Daily improvement report (docs/infrastructure.md §4.3): open tickets + metrics → summary and proposals.
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { proposals, reports, tickets, type AppRow, type ProposalRow, type ReportRow, type ReportStats } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { ReportDraft, type ReportTicket } from '../llm/types.ts';

export interface RunReportInput {
  date?: string;
  metrics?: Record<string, number | string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TICKETS = 100;

const tally = (values: (string | null)[]) =>
  values.reduce<Record<string, number>>((acc, v) => {
    const k = v ?? 'unlabeled';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

export async function runReport(ctx: Ctx, app: AppRow, input: RunReportInput): Promise<{ report: ReportRow; proposals: ProposalRow[] }> {
  const { db, llm } = ctx;
  const now = ctx.now();
  const [last] = await db.select({ createdAt: reports.createdAt }).from(reports).where(eq(reports.app, app.slug)).orderBy(desc(reports.createdAt)).limit(1);
  const from = last?.createdAt ?? new Date(now.getTime() - DAY_MS);

  const received = await db
    .select({ valid: tickets.valid, duplicateOf: tickets.duplicateOf })
    .from(tickets)
    .where(and(eq(tickets.app, app.slug), gte(tickets.createdAt, from), lt(tickets.createdAt, now)));

  const open = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.app, app.slug),
        isNull(tickets.duplicateOf),
        or(isNull(tickets.valid), eq(tickets.valid, true)),
        inArray(tickets.status, ['new', 'triaged', 'progress']),
      ),
    )
    .orderBy(desc(tickets.votes), desc(tickets.createdAt))
    .limit(MAX_TICKETS);

  const stats: ReportStats = {
    window: { from: from.toISOString(), to: now.toISOString() },
    received: received.length,
    valid: received.filter((t) => t.valid === true && !t.duplicateOf).length,
    mergedOrNoise: received.filter((t) => t.valid === false || t.duplicateOf).length,
    open: open.length,
    byType: tally(open.map((t) => t.type)),
    byPriority: tally(open.map((t) => t.priority)),
    metrics: input.metrics ?? {},
  };
  const date = input.date ?? now.toISOString().slice(0, 10);

  const draft: ReportDraft =
    open.length === 0
      ? { summary: 'No open feedback right now. Nothing to change today.', proposals: [] }
      : ReportDraft.parse(
          await llm.report({
            app: { slug: app.slug, name: app.name, description: app.description },
            date,
            stats,
            tickets: open.map(
              (t): ReportTicket => ({ key: t.key, type: t.type, priority: t.priority, status: t.status, title: t.title, text: t.text, votes: t.votes, route: t.route }),
            ),
          }),
        );

  const known = new Set(open.map((t) => t.key));
  return db.transaction(async (tx) => {
    const [report] = await tx.insert(reports).values({ app: app.slug, date, summary: draft.summary, stats }).returning();
    const rows = draft.proposals.map((p, i) => ({
      reportId: report!.id,
      app: app.slug,
      position: i + 1,
      title: p.title,
      body: p.body,
      refs: [...new Set(p.refs.filter((r) => known.has(r)))],
      impact: p.impact,
      effort: p.effort,
      affects: p.affects,
    }));
    const inserted = rows.length ? await tx.insert(proposals).values(rows).returning() : [];
    return { report: report!, proposals: inserted };
  });
}

export async function proposalCounts(ctx: Ctx, reportIds: string[]) {
  if (reportIds.length === 0) return new Map<string, Record<string, number>>();
  const rows = await ctx.db
    .select({ reportId: proposals.reportId, status: proposals.status, n: sql<number>`count(*)::int` })
    .from(proposals)
    .where(inArray(proposals.reportId, reportIds))
    .groupBy(proposals.reportId, proposals.status);
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const m = out.get(r.reportId) ?? {};
    m[r.status] = r.n;
    out.set(r.reportId, m);
  }
  return out;
}
