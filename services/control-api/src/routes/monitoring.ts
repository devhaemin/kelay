// Monitoring: the `runs` table, how services record into it (service caller), and what the Monitoring and
// Agent tabs read from it (builder).
import { Hono } from 'hono';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { AppSlug, McpCallRecord } from '@kelay/contracts';
import { requireBuilder, requireService, type AppEnv } from '../auth.ts';
import { ACTION_STATUSES, appMembers, apps, CALLER_KINDS, consents, ENV_NAMES, runs, type RunRow } from '../db/schema.ts';
import type { Ctx } from '../deps.ts';
import { jsonBody, loadApp, queryParams } from './util.ts';

const INGEST_LIMIT = 500;
const RECENT_RUNS = 20;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const RANGES = { '24h': { unit: 'hour', buckets: 24 }, '14d': { unit: 'day', buckets: 14 }, '30d': { unit: 'day', buckets: 30 } } as const;

const MetricsQuery = z.object({ range: z.enum(['24h', '14d', '30d']).optional(), env: z.enum(ENV_NAMES).optional() });

const RunRecord = z.object({
  app: AppSlug,
  env: z.enum(ENV_NAMES).optional(),
  action: z.string().trim().min(1).max(200),
  args: z.string().max(500).optional(),
  userId: z.string().min(1).max(200).optional(),
  status: z.enum(ACTION_STATUSES),
  ms: z.number().int().min(0).optional(),
  caller: z
    .object({ kind: z.enum(CALLER_KINDS), id: z.string().max(500).optional(), name: z.string().max(200).optional() })
    .optional(),
  note: z.string().max(1000).optional(),
  costUsd: z.number().min(0).max(100_000).optional(),
  at: z.iso.datetime().optional(),
});

const RunsBody = z.object({ runs: z.array(RunRecord).min(1).max(INGEST_LIMIT) });
const McpCallsBody = z.object({ calls: z.array(McpCallRecord).min(1).max(INGEST_LIMIT) });

const callerApps = alias(apps, 'caller_apps');

const pct = (now: number, before: number): number => (before === 0 ? 0 : Math.round(((now - before) / before) * 100));

/** How the Monitoring tab names where a run came from. */
function sourceOf(run: RunRow, callerAppName: string | null): string {
  if (run.callerKind === 'agent') return `${run.callerName ?? run.callerId ?? 'Personal agent'} (MCP)`;
  if (run.callerKind === 'app') return callerAppName ?? run.callerName ?? run.callerId ?? 'Another app';
  return 'App';
}

export function monitoringRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();
  const { db } = ctx;
  const builder = requireBuilder(ctx.auth);
  const service = requireService(ctx.auth);

  /** Apps in a batch that exist; records for any other app are skipped instead of failing the batch. */
  const knownApps = async (slugs: string[]): Promise<Set<string>> => {
    const rows = await db.select({ slug: apps.slug }).from(apps).where(inArray(apps.slug, [...new Set(slugs)]));
    return new Set(rows.map((a) => a.slug));
  };

  r.post('/internal/v1/runs', service, jsonBody(RunsBody), async (c) => {
    const records = c.req.valid('json').runs;
    const known = await knownApps(records.map((x) => x.app));
    const rows = records
      .filter((x) => known.has(x.app))
      .map((x) => ({
        app: x.app,
        env: x.env ?? 'prod',
        action: x.action,
        args: x.args ?? null,
        userId: x.userId ?? null,
        status: x.status,
        ms: x.ms ?? 0,
        callerKind: x.caller?.kind ?? 'user',
        callerId: x.caller?.id ?? null,
        callerName: x.caller?.name ?? null,
        note: x.note ?? null,
        costUsd: String(x.costUsd ?? 0),
        at: x.at ? new Date(x.at) : ctx.now(),
      }));
    if (rows.length) await db.insert(runs).values(rows);
    return c.json({ recorded: rows.length, skipped: records.length - rows.length }, 201);
  });

  r.post('/internal/v1/mcp-calls', service, jsonBody(McpCallsBody), async (c) => {
    const calls = c.req.valid('json').calls;
    const known = await knownApps(calls.map((x) => x.app));
    const accepted = calls.filter((x) => known.has(x.app));
    if (accepted.length === 0) return c.json({ recorded: 0, skipped: calls.length }, 201);

    // The consent names the assistant ("Claude Desktop") and ties each call to the connection it used.
    const granted = await db
      .select()
      .from(consents)
      .where(and(inArray(consents.app, [...known]), inArray(consents.clientId, [...new Set(accepted.map((x) => x.client))])))
      .orderBy(desc(consents.createdAt));
    const key = (app: string, user: string, client: string) => `${app}\n${user}\n${client}`;
    const consentOf = new Map<string, (typeof granted)[number]>();
    for (const g of granted) {
      const k = key(g.app, g.userId, g.clientId);
      const seen = consentOf.get(k);
      if (!seen || (seen.revokedAt && !g.revokedAt)) consentOf.set(k, g);
    }

    const now = ctx.now();
    const lastUsed = new Map<string, Date>();
    const rows = accepted.map((x) => {
      const consent = consentOf.get(key(x.app, x.sub, x.client));
      const at = x.at ? new Date(x.at) : now;
      if (consent && !consent.revokedAt && at > (lastUsed.get(consent.id) ?? new Date(0))) lastUsed.set(consent.id, at);
      return {
        app: x.app,
        action: x.tool,
        args: x.args ?? null,
        userId: x.sub,
        status: x.ok ? ('ok' as const) : x.denied ? ('blocked' as const) : ('error' as const),
        ms: x.ms,
        callerKind: 'agent' as const,
        callerId: x.client,
        callerName: consent?.clientName ?? null,
        consentId: consent?.id ?? null,
        at,
      };
    });
    await db.transaction(async (tx) => {
      await tx.insert(runs).values(rows);
      for (const [id, at] of lastUsed) {
        await tx
          .update(consents)
          .set({ lastUsedAt: at })
          .where(and(eq(consents.id, id), isNull(consents.revokedAt), sql`coalesce(${consents.lastUsedAt}, '-infinity') < ${at.toISOString()}::timestamptz`));
      }
    });
    return c.json({ recorded: rows.length, skipped: calls.length - rows.length }, 201);
  });

  r.get('/v1/apps/:app/metrics', builder, queryParams(MetricsQuery), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const q = c.req.valid('query');
    const range = q.range ?? '24h';
    const { unit, buckets } = RANGES[range];
    const now = ctx.now();
    const nowIso = now.toISOString();
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const inEnv = q.env ? sql`and env = ${q.env}` : sql``;

    const kpis = await db.execute<{
      active: number;
      active_before: number;
      actions: number;
      actions_before: number;
      errors: number;
      screen_errors: number;
      agent_actions: number;
      cost: string;
    }>(sql`
      select
        count(distinct user_id) filter (where at >= ${ago(7 * DAY_MS)}::timestamptz)::int as active,
        count(distinct user_id) filter (where at < ${ago(7 * DAY_MS)}::timestamptz)::int as active_before,
        count(*) filter (where at >= ${ago(DAY_MS)}::timestamptz)::int as actions,
        count(*) filter (where at >= ${ago(2 * DAY_MS)}::timestamptz and at < ${ago(DAY_MS)}::timestamptz)::int as actions_before,
        count(*) filter (where at >= ${ago(DAY_MS)}::timestamptz and status = 'error')::int as errors,
        count(*) filter (where at >= ${ago(7 * DAY_MS)}::timestamptz and status = 'error' and caller_kind = 'user')::int as screen_errors,
        count(*) filter (where at >= ${ago(DAY_MS)}::timestamptz and caller_kind = 'agent')::int as agent_actions,
        coalesce(sum(cost_usd) filter (where at >= ${ago(DAY_MS)}::timestamptz), 0)::text as cost
      from runs
      where app = ${app.slug} and at >= ${ago(14 * DAY_MS)}::timestamptz and at <= ${nowIso}::timestamptz ${inEnv}`);
    const k = kpis.rows[0]!;

    const [members] = await db
      .select({ total: sql<number>`count(*) filter (where ${appMembers.status} <> 'banned')::int` })
      .from(appMembers)
      .where(eq(appMembers.app, app.slug));

    // Buckets are UTC hours or UTC days, oldest first; the last one holds `now`.
    const step = sql.raw(`interval '1 ${unit}'`);
    const last = sql`date_trunc(${unit}::text, ${nowIso}::timestamptz, 'UTC')`;
    const series = await db.execute<{ bucket: Date; actions: number; errors: number }>(sql`
      select b as bucket, count(r.id)::int as actions, count(r.id) filter (where r.status = 'error')::int as errors
      from generate_series(${last} - ${buckets - 1}::int * ${step}, ${last}, ${step}) as b
      left join runs r on r.app = ${app.slug} and r.at >= b and r.at < b + ${step} and r.at <= ${nowIso}::timestamptz ${q.env ? sql`and r.env = ${q.env}` : sql``}
      group by b order by b`);

    const recent = await db
      .select({ run: runs, callerAppName: callerApps.name })
      .from(runs)
      .leftJoin(callerApps, and(eq(runs.callerKind, 'app'), eq(callerApps.slug, runs.callerId)))
      .where(and(eq(runs.app, app.slug), q.env ? eq(runs.env, q.env) : undefined))
      .orderBy(desc(runs.at))
      .limit(RECENT_RUNS);

    return c.json({
      metrics: {
        range,
        // Fewer than 1 in 20 runs failed in the last 24 hours.
        healthy: k.errors * 20 <= k.actions,
        activeMembers: { value: k.active, total: members?.total ?? 0, delta: k.active - k.active_before },
        actionsToday: { value: k.actions, deltaPct: pct(k.actions, k.actions_before) },
        screenErrors7d: { value: k.screen_errors, note: null as string | null },
        agentActionsToday: k.agent_actions,
        llmBudgetTodayUsd: Number(k.cost),
        series: {
          buckets: series.rows.map((b) => new Date(b.bucket).toISOString()),
          actions: series.rows.map((b) => b.actions),
          errors: series.rows.map((b) => b.errors),
        },
        recent: recent.map(({ run, callerAppName }) => ({
          id: run.id,
          action: run.action,
          args: run.args,
          by: run.userId ?? '',
          status: run.status,
          ms: run.ms,
          source: sourceOf(run, callerAppName),
          caller: { kind: run.callerKind, id: run.callerId, name: run.callerKind === 'app' ? (callerAppName ?? run.callerName) : run.callerName },
          env: run.env,
          note: run.note,
          at: run.at,
        })),
      },
    });
  });

  r.get('/v1/apps/:app/tool-calls', builder, queryParams(z.object({ limit: z.coerce.number().int().min(1).max(500).optional() })), async (c) => {
    const app = await loadApp(db, c.req.param('app'), c.get('principal'));
    const rows = await db
      .select()
      .from(runs)
      .where(and(eq(runs.app, app.slug), eq(runs.callerKind, 'agent')))
      .orderBy(desc(runs.at))
      .limit(c.req.valid('query').limit ?? 100);
    return c.json({
      toolCalls: rows.map((run) => ({
        id: run.id,
        consentId: run.consentId,
        at: run.at,
        tool: run.action,
        args: run.args ?? '',
        result: run.status === 'ok' ? 'ok' : run.status === 'blocked' ? 'denied' : 'error',
        note: run.note,
        userId: run.userId,
        clientId: run.callerId,
        clientName: run.callerName,
        ms: run.ms,
      })),
    });
  });

  return r;
}
