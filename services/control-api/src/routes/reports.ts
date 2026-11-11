// Daily improvement reports and the approve / reject decision on their proposals.
import { Hono } from 'hono';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { requireBuilder, requireBuilderOrService, type AppEnv } from '../auth.ts';
import { improvementRuns, proposals, reports, ticketEvents, tickets, type ImprovementRunRow, type ProposalRow } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { LlmError } from '../llm/types.ts';
import { proposalCounts, runReport } from '../services/reports.ts';
import { actorOf, jsonBody, loadApp, queryParams } from './util.ts';

const RunBody = z
  .object({
    date: z.iso.date().optional(),
    /** Simple metrics from Monitoring, e.g. { activeMembers7d: 11, actionsToday: 210, screenErrors7d: 0 }. */
    metrics: z.record(z.string().max(64), z.union([z.number(), z.string().max(200)])).optional(),
  })
  .optional();

function proposalView(p: ProposalRow, run?: ImprovementRunRow | null) {
  return {
    id: p.id,
    reportId: p.reportId,
    app: p.app,
    position: p.position,
    title: p.title,
    body: p.body,
    refs: p.refs,
    impact: p.impact,
    effort: p.effort,
    affects: p.affects,
    status: p.status,
    decidedBy: p.decidedBy,
    decidedAt: p.decidedAt,
    createdAt: p.createdAt,
    run: run ? { id: run.id, status: run.status, branch: run.branch, versionId: run.versionId, createdAt: run.createdAt } : null,
  };
}

export function reportRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const { db } = ctx;
  const builder = requireBuilder(ctx.auth);

  r.post('/v1/apps/:app/reports/run', requireBuilderOrService(ctx.auth), jsonBody(RunBody), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    try {
      const out = await runReport(ctx, app, c.req.valid('json') ?? {});
      ctx.logger.info({ type: 'report', app: app.slug, report: out.report.id, proposals: out.proposals.length }, 'report built');
      return c.json({ report: out.report, proposals: out.proposals.map((p) => proposalView(p)) }, 201);
    } catch (e) {
      if (e instanceof LlmError || e instanceof z.ZodError) {
        ctx.logger.error({ type: 'report_failed', app: app.slug, err: (e as Error).message }, 'report failed');
        throw new ApiError('internal', `report generation failed: ${(e as Error).message}`);
      }
      throw e;
    }
  });

  r.get('/v1/apps/:app/reports', builder, queryParams(z.object({ limit: z.coerce.number().int().min(1).max(100).optional() })), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const rows = await db
      .select()
      .from(reports)
      .where(eq(reports.app, app.slug))
      .orderBy(desc(reports.createdAt))
      .limit(c.req.valid('query').limit ?? 30);
    const counts = await proposalCounts(ctx, rows.map((x) => x.id));
    return c.json({ reports: rows.map((x) => ({ ...x, proposals: counts.get(x.id) ?? {} })) });
  });

  r.get('/v1/apps/:app/reports/:id', builder, async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const id = c.req.param('id');
    const report =
      id === 'latest'
        ? await db.query.reports.findFirst({ where: eq(reports.app, app.slug), orderBy: desc(reports.createdAt) })
        : z.uuid().safeParse(id).success
          ? await db.query.reports.findFirst({ where: and(eq(reports.app, app.slug), eq(reports.id, id)) })
          : undefined;
    if (!report) throw new ApiError('not_found', 'no such report');
    const props = await db.select().from(proposals).where(eq(proposals.reportId, report.id)).orderBy(asc(proposals.position));
    const runs = props.length
      ? await db
          .select()
          .from(improvementRuns)
          .where(inArray(improvementRuns.proposalId, props.map((p) => p.id)))
          .orderBy(desc(improvementRuns.createdAt))
      : [];
    const latestRun = (pid: string) => runs.find((run) => run.proposalId === pid) ?? null;
    return c.json({ report, proposals: props.map((p) => proposalView(p, latestRun(p.id))) });
  });

  const loadProposal = async (id: string) => {
    if (!z.uuid().safeParse(id).success) throw new ApiError('not_found', 'no such proposal');
    const p = await db.query.proposals.findFirst({ where: eq(proposals.id, id) });
    if (!p) throw new ApiError('not_found', 'no such proposal');
    return p;
  };

  r.post('/v1/proposals/:id/approve', builder, async (c) => {
    const principal = c.get('principal');
    const found = await loadProposal(c.req.param('id'));
    await loadApp(db, found.app, principal);
    const actor = actorOf(principal);
    const { proposal, run } = await db.transaction(async (tx) => {
      const [proposal] = await tx
        .update(proposals)
        .set({ status: 'approved', decidedBy: actor, decidedAt: ctx.now() })
        .where(and(eq(proposals.id, found.id), eq(proposals.status, 'pending')))
        .returning();
      if (!proposal) throw new ApiError('conflict', `proposal is already ${found.status}`);
      const [run] = await tx.insert(improvementRuns).values({ proposalId: proposal.id, app: proposal.app }).returning();
      if (proposal.refs.length) {
        const moved = await tx
          .update(tickets)
          .set({ status: 'progress', updatedAt: ctx.now() })
          .where(and(eq(tickets.app, proposal.app), inArray(tickets.key, proposal.refs), inArray(tickets.status, ['new', 'triaged'])))
          .returning({ id: tickets.id });
        if (moved.length) {
          await tx
            .insert(ticketEvents)
            .values(moved.map((t) => ({ ticketId: t.id, kind: 'status', actor, data: { to: 'progress', proposal: proposal.id } })));
        }
      }
      return { proposal, run: run! };
    });
    try {
      await ctx.improvements.enqueue(run);
    } catch (e) {
      // The run row stays queued, so a worker that polls still finds it.
      ctx.logger.error({ type: 'enqueue_failed', run: run.id, err: (e as Error).message }, 'improvement enqueue failed');
    }
    ctx.logger.info({ type: 'proposal_approved', app: proposal.app, proposal: proposal.id, run: run.id }, 'proposal approved');
    return c.json({ proposal: proposalView(proposal, run), run });
  });

  r.post('/v1/proposals/:id/reject', builder, async (c) => {
    const principal = c.get('principal');
    const found = await loadProposal(c.req.param('id'));
    await loadApp(db, found.app, principal);
    const [proposal] = await db
      .update(proposals)
      .set({ status: 'rejected', decidedBy: actorOf(principal), decidedAt: ctx.now() })
      .where(and(eq(proposals.id, found.id), eq(proposals.status, 'pending')))
      .returning();
    if (!proposal) throw new ApiError('conflict', `proposal is already ${found.status}`);
    return c.json({ proposal: proposalView(proposal) });
  });

  return r;
}
