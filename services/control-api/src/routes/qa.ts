// The QA tab: run the app's checks, read the latest run, and the incident timeline built from bug tickets.
import { Hono } from 'hono';
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireBuilder, requireBuilderOrService, type AppEnv } from '../auth.ts';
import { ENV_NAMES, proposals, qaRuns, runs, ticketEvents, tickets, versions, type QaCheckResult, type QaRunRow } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { ApiError } from '../errors.ts';
import { actorOf, jsonBody, loadApp, loadEnv, queryParams } from './util.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const INCIDENT_WINDOW_DAYS = 30;
const MAX_INCIDENTS = 10;

const RunBody = z.object({ env: z.enum(ENV_NAMES).optional() }).optional();

function checkView(check: QaCheckResult) {
  const can = check.expected === 'allow' ? 'can' : 'can’t';
  return {
    name: `${check.role} ${can} ${check.op} ${check.collection}`,
    status: check.ok ? ('ok' as const) : ('bad' as const),
    durationMs: check.ms,
    note: check.ok ? check.note : (check.note ?? `expected ${check.expected}, the database answered ${check.actual}`),
    role: check.role,
    collection: check.collection,
    op: check.op,
    expected: check.expected,
    actual: check.actual,
  };
}

interface TimelineEntry {
  at: Date;
  tone: 'red' | 'green' | null;
  text: string;
}

export function qaRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const { db } = ctx;

  /** Bug tickets of the last 30 days, each with what happened to it, newest first. */
  const incidents = async (app: string) => {
    const since = new Date(ctx.now().getTime() - INCIDENT_WINDOW_DAYS * DAY_MS);
    const bugs = await db
      .select()
      .from(tickets)
      .where(
        and(eq(tickets.app, app), eq(tickets.type, 'bug'), isNull(tickets.duplicateOf), or(isNull(tickets.valid), eq(tickets.valid, true)), gte(tickets.createdAt, since)),
      )
      .orderBy(desc(tickets.createdAt))
      .limit(MAX_INCIDENTS);
    if (bugs.length === 0) return [];
    const events = await db
      .select()
      .from(ticketEvents)
      .where(inArray(ticketEvents.ticketId, bugs.map((b) => b.id)))
      .orderBy(asc(ticketEvents.createdAt));
    const fixes = await db
      .select()
      .from(proposals)
      .where(and(eq(proposals.app, app), ne(proposals.status, 'rejected'), sql`${proposals.refs} && ${sql.param(bugs.map((b) => b.key))}::text[]`));

    return bugs.map((bug) => {
      const timeline: TimelineEntry[] = [
        { at: bug.createdAt, tone: 'red', text: `[[${bug.key}]] reported${bug.route ? ` on \`${bug.route}\`` : ''}: _${bug.text.replace(/\s+/g, ' ').slice(0, 200)}_` },
      ];
      if (bug.votes > 1) timeline.push({ at: bug.updatedAt, tone: null, text: `${bug.votes} people hit it.` });
      for (const p of fixes.filter((x) => x.refs.includes(bug.key))) {
        timeline.push({ at: p.createdAt, tone: null, text: `Daily report proposed: ${p.title}.` });
        if (p.decidedAt && p.status !== 'pending') timeline.push({ at: p.decidedAt, tone: null, text: 'The fix was approved.' });
      }
      const done = events.findLast((e) => e.ticketId === bug.id && (e.data.status === 'done' || e.data.to === 'done'));
      if (bug.status === 'done') {
        timeline.push({ at: done?.createdAt ?? bug.updatedAt, tone: 'green', text: bug.fixedIn ? `Fixed in **${bug.fixedIn}**.` : 'Fixed.' });
      }
      timeline.sort((a, b) => a.at.getTime() - b.at.getTime());
      return {
        ticket: bug.key,
        title: `Caught: ${bug.title}`,
        resolved: bug.status === 'done',
        timeline: timeline.map((t) => ({ at: t.at, when: t.at.toISOString(), tone: t.tone, text: t.text })),
      };
    });
  };

  const view = async (run: QaRunRow) => {
    const checks = run.checks.map(checkView);
    const roles = [...new Set(run.checks.map((x) => x.role))].map((role) => {
      const own = checks.filter((x) => x.role === role);
      return { role, passing: own.filter((x) => x.status === 'ok').length, total: own.length, checks: own };
    });
    const version = run.versionId ? await db.query.versions.findFirst({ where: eq(versions.id, run.versionId), columns: { number: true } }) : undefined;
    const [reached] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.app, run.app), eq(runs.status, 'error'), eq(runs.callerKind, 'user'), gte(runs.at, new Date(ctx.now().getTime() - 7 * DAY_MS))));
    return {
      id: run.id,
      app: run.app,
      env: run.env,
      status: run.status,
      error: run.error,
      version: version ? `v${version.number}` : null,
      versionId: run.versionId,
      startedBy: run.startedBy,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      passing: checks.filter((x) => x.status === 'ok').length,
      total: checks.length,
      errorsReachedUsers7d: reached?.n ?? 0,
      checks,
      roles,
      incidents: await incidents(run.app),
    };
  };

  r.post('/v1/apps/:app/qa/run', requireBuilderOrService(ctx.auth), jsonBody(RunBody), async (c) => {
    const principal = c.get('principal');
    const app = await loadApp(db, c.req.param('app'), principal);
    const envName = c.req.valid('json')?.env ?? 'dev';
    const { env, version } = await loadEnv(db, app.slug, envName);
    if (!version?.schema) throw new ApiError('conflict', `app ${app.slug} has no schema deployed to ${envName} yet`);
    if (!env.databaseUrl) throw new ApiError('conflict', `the ${envName} environment has no database yet`);

    const startedAt = ctx.now();
    let checks: QaCheckResult[] = [];
    let error: string | null = null;
    try {
      checks = await ctx.qa.run({ app: app.slug, env: envName, schema: version.schema, policy: version.policy ?? {}, databaseUrl: env.databaseUrl });
    } catch (e) {
      error = (e as Error).message;
      ctx.logger.error({ type: 'qa_failed', app: app.slug, env: envName, runner: ctx.qa.name, err: error }, 'QA run could not finish');
    }
    const [run] = await db
      .insert(qaRuns)
      .values({
        app: app.slug,
        env: envName,
        versionId: version.id,
        status: error ? 'error' : checks.every((x) => x.ok) ? 'passed' : 'failed',
        checks,
        error,
        startedBy: actorOf(principal),
        startedAt,
        finishedAt: ctx.now(),
      })
      .returning();
    ctx.logger.info({ type: 'qa_run', app: app.slug, env: envName, run: run!.id, status: run!.status, checks: checks.length }, 'QA run stored');
    return c.json({ qa: await view(run!) }, 201);
  });

  r.get('/v1/apps/:app/qa', requireBuilder(ctx.auth), queryParams(z.object({ env: z.enum(ENV_NAMES).optional() })), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const env = c.req.valid('query').env;
    const run = await db.query.qaRuns.findFirst({
      where: and(eq(qaRuns.app, app.slug), env ? eq(qaRuns.env, env) : undefined),
      orderBy: desc(qaRuns.startedAt),
    });
    if (!run) throw new ApiError('not_found', `no QA run for ${app.slug} yet`);
    return c.json({ qa: await view(run) });
  });

  return r;
}
