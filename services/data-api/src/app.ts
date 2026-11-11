// Data API (contract §5): the only path to app data. Verifies the caller and the user,
// validates the query against the app schema, and runs it under the user's claims so RLS applies.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { pino, type Logger } from 'pino';
import { z } from 'zod';
import {
  CALLER_HEADER,
  QueryRequest,
  type AppRegistry,
  type AppRegistryEntry,
  type CallerClaims,
  type KelayClaims,
  type QueryResponse,
} from '@kelay/contracts';
import { TokenError, verifyCallerToken, verifyKelayToken, type VerifyOptions } from '@kelay/tokens';
import { asUser, createDatabases, DbSetupError, type Databases } from './db.ts';
import { ApiError, fromDatabaseError, invalid } from './errors.ts';
import { planQuery } from './query.ts';

export { createDatabases, type Databases } from './db.ts';

export interface DataApiDeps {
  /** Verifies Kelay ID user tokens; `remoteJwks(KELAY_ID_JWKS_URL)` in production. */
  jwks: VerifyOptions['jwks'];
  issuer: string;
  callerSecret: string;
  registry: AppRegistry;
  /** Owns the app database pools. Pass one to close it on shutdown. */
  databases?: Databases;
  logger?: Logger;
}

export const MAX_BODY_BYTES = 1024 * 1024;

interface QueryLog {
  type: 'data_query';
  app: string;
  op?: QueryRequest['op'];
  collection?: string;
  sub?: string;
  caller?: string;
  status?: number;
  ms?: number;
  count?: number;
  code?: string;
}

type Env = { Variables: { line?: QueryLog } };

const BEARER = /^Bearer +(\S+)$/i;

export function createLogger(): Logger {
  return pino({ base: { svc: 'data-api' }, serializers: { err: pino.stdSerializers.errWithCause } });
}

export function createApp(deps: DataApiDeps): Hono<Env> {
  const logger = deps.logger ?? createLogger();
  const databases =
    deps.databases ?? createDatabases({ onPoolError: (err) => logger.error({ type: 'pool_error', err }, 'idle client error') });
  const app = new Hono<Env>();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.use('/v1/apps/:app/query', async (c, next) => {
    const started = performance.now();
    const line: QueryLog = { type: 'data_query', app: c.req.param('app') ?? '' };
    c.set('line', line);
    await next();
    line.status = c.res.status;
    line.ms = Math.round((performance.now() - started) * 10) / 10;
    if (line.status >= 500) logger.error({ ...line, err: c.error }, 'query failed');
    else logger.info(line, 'query');
  });

  app.post(
    '/v1/apps/:app/query',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw invalid(`request body exceeds ${MAX_BODY_BYTES} bytes`);
      },
    }),
    async (c) => {
      const slug = c.req.param('app');
      const line = c.get('line');
      const caller = await verifyCaller(c.req.header(CALLER_HEADER), slug, deps.callerSecret);
      if (line) line.caller = caller.kind === 'service' ? `service:${caller.svc}` : `app-runtime:${caller.app}`;
      const claims = await verifyUser(c.req.header('authorization'), slug, deps);
      if (line) line.sub = claims.sub;
      const entry = lookupApp(deps.registry, slug);

      const req = parseRequest(await readJson(c));
      if (line) Object.assign(line, { op: req.op, collection: req.collection });
      const collection = entry.schema.collections.find((col) => col.name === req.collection);
      if (!collection) throw new ApiError('unknown_collection', `app "${slug}" has no collection "${req.collection}"`);
      const plan = planQuery(collection, req);

      const rows = await asUser(databases.get(entry.databaseUrl), claims, async (trx) => {
        const result = await trx.executeQuery(plan.query);
        // RLS hides rows from UPDATE/DELETE silently; tell the caller apart from "nothing matched".
        if (plan.probe && result.rows.length === 0 && (await trx.executeQuery(plan.probe)).rows.length > 0) {
          throw new ApiError('denied', `not allowed to ${req.op} the matching ${req.collection}`);
        }
        return result.rows;
      });
      if (line) line.count = rows.length;
      return c.json({ rows, count: rows.length } satisfies QueryResponse);
    },
  );

  app.onError((err, c) => {
    const apiError = toApiError(err);
    const line = c.get('line');
    if (line) line.code = apiError.code;
    return c.json(apiError.toJSON(), apiError.status as ContentfulStatusCode);
  });

  return app;
}

async function verifyCaller(token: string | undefined, app: string, secret: string): Promise<CallerClaims> {
  if (!token) throw new ApiError('forbidden_caller', `missing ${CALLER_HEADER} header`);
  let caller: CallerClaims;
  try {
    caller = await verifyCallerToken(token, secret);
  } catch (e) {
    throw new ApiError('forbidden_caller', e instanceof TokenError ? e.message : 'invalid caller token');
  }
  if (caller.kind === 'app-runtime' && caller.app !== app) {
    throw new ApiError('forbidden_caller', 'an app runtime may only query its own app');
  }
  if (caller.kind === 'service' && !caller.svc) throw new ApiError('forbidden_caller', 'service caller token has no svc');
  return caller;
}

async function verifyUser(header: string | undefined, app: string, deps: DataApiDeps): Promise<KelayClaims> {
  const token = BEARER.exec(header ?? '')?.[1];
  if (!token) throw new ApiError('unauthenticated', 'missing bearer token');
  try {
    return await verifyKelayToken(token, { jwks: deps.jwks, issuer: deps.issuer, app });
  } catch (e) {
    if (e instanceof TokenError) throw new ApiError('unauthenticated', e.message);
    throw e;
  }
}

function lookupApp(registry: AppRegistry, slug: string): AppRegistryEntry {
  const entry = Object.hasOwn(registry.apps, slug) ? registry.apps[slug] : undefined;
  if (!entry) throw new ApiError('unknown_app', `no app "${slug}"`);
  return entry;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw invalid('request body must be JSON');
  }
}

function parseRequest(body: unknown): QueryRequest {
  const parsed = QueryRequest.safeParse(body);
  if (!parsed.success) throw invalid(z.prettifyError(parsed.error));
  return parsed.data;
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (!(err instanceof DbSetupError)) {
    const mapped = fromDatabaseError(err);
    if (mapped) return mapped;
  }
  return new ApiError('internal', 'internal error');
}
