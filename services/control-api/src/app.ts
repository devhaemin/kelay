import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requestId, type RequestIdVariables } from 'hono/request-id';
import { sql } from 'drizzle-orm';
import type { AppEnv } from './auth.ts';
import { createAppDatabases } from './appdb.ts';
import { DEFAULT_CALLER_TOKEN_TTL_SECONDS, DEFAULT_DEDUPE_THRESHOLD, type ControlApiDeps, type Ctx } from './deps.ts';
import { ApiError, errorBody, sendError } from './errors.ts';
import { PgAppDatabaseMigrator } from './deploy/migrator.ts';
import { createLogger } from './log.ts';
import { appRoutes } from './routes/apps.ts';
import { consentRoutes } from './routes/consents.ts';
import { deployRoutes } from './routes/deploy.ts';
import { feedbackRoutes } from './routes/feedback.ts';
import { grantRoutes } from './routes/grants.ts';
import { internalRoutes } from './routes/internal.ts';
import { meRoutes } from './routes/me.ts';
import { monitoringRoutes } from './routes/monitoring.ts';
import { policyRoutes } from './routes/policy.ts';
import { publicRoutes } from './routes/public.ts';
import { qaRoutes } from './routes/qa.ts';
import { reportRoutes } from './routes/reports.ts';
import { PolicyQaRunner } from './qa/runner.ts';

type RootEnv = AppEnv & { Variables: RequestIdVariables };

export function createControlApi(deps: ControlApiDeps): Hono<RootEnv> {
  const logger = deps.logger ?? createLogger();
  const appDbs = deps.appDbs ?? createAppDatabases({ onPoolError: (err) => logger.error({ type: 'app_db', err: err.message }, 'app database connection failed') });
  const ctx: Ctx = {
    ...deps,
    logger,
    appDbs,
    appMigrator: deps.appMigrator ?? new PgAppDatabaseMigrator(),
    qa: deps.qa ?? new PolicyQaRunner(appDbs),
    dedupeThreshold: deps.dedupeThreshold ?? DEFAULT_DEDUPE_THRESHOLD,
    callerTokenTtlSeconds: deps.callerTokenTtlSeconds ?? DEFAULT_CALLER_TOKEN_TTL_SECONDS,
    now: deps.now ?? (() => new Date()),
  };
  const log = ctx.logger;
  const app = new Hono<RootEnv>();

  app.use(requestId());
  app.use(async (c, next) => {
    const start = performance.now();
    await next();
    // Platform services read the app registry every few seconds (contract §6); those reads would bury everything else.
    const registryRead = c.req.method === 'GET' && c.req.path.startsWith('/internal/v1/apps') && c.res.status < 500;
    log[registryRead ? 'debug' : 'info'](
      { type: 'http', method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - start), reqId: c.get('requestId') },
      'request',
    );
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return sendError(c, err);
    if (err instanceof HTTPException && err.status < 500) {
      const code = err.status === 401 ? 'unauthenticated' : 'invalid_request';
      return c.json(errorBody(code, err.message || 'bad request'), err.status);
    }
    log.error({ type: 'error', err, path: c.req.path, reqId: c.get('requestId') }, 'unhandled error');
    return c.json(errorBody('internal', 'internal error'), 500);
  });
  app.notFound((c) => c.json(errorBody('not_found', `no route ${c.req.method} ${c.req.path}`), 404));

  app.get('/healthz', async (c) => {
    try {
      await ctx.db.execute(sql`select 1`);
      return c.json({ ok: true, service: 'control-api', db: 'ok', deployDriver: ctx.deploy.name, improvementQueue: ctx.improvements.kind });
    } catch (e) {
      log.error({ type: 'healthz', err: (e as Error).message }, 'database unreachable');
      return c.json({ ok: false, service: 'control-api', db: 'down' }, 503);
    }
  });

  for (const routes of [meRoutes, appRoutes, policyRoutes, monitoringRoutes, qaRoutes, feedbackRoutes, reportRoutes, grantRoutes, consentRoutes, deployRoutes, internalRoutes, publicRoutes]) {
    app.route('/', routes(ctx) as unknown as Hono<RootEnv>);
  }
  return app;
}
