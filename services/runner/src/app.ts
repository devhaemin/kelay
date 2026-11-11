// Run orchestrator (docs/infrastructure.md §4.2): starts an app's agent graph as the calling user,
// follows it to the end, and records it. A run carries the user's Kelay ID token through every node,
// so what the nodes read and write is decided by that user's RLS.
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { AppSlug, CALLER_HEADER, HTTP_STATUS, type CallerClaims, type ErrorCode, type ErrorResponse, type KelayClaims } from '@kelay/contracts';
import { TokenError, verifyCallerToken, verifyKelayToken, type VerifyOptions } from '@kelay/tokens';
import { UnknownGraphError, type RunDriver, type RunResult } from './driver.ts';
import { stdoutRecorder, toRecord, type RunRecorder } from './recorder.ts';
import { createRunStore, type Run, type RunCaller, type RunStore } from './store.ts';

export interface RunnerDeps {
  driver: RunDriver;
  /** Verifies Kelay ID user tokens; `remoteJwks(KELAY_ID_JWKS_URL)` in production. */
  jwks: VerifyOptions['jwks'];
  issuer: string;
  callerSecret: string;
  /** Runs one user may have in progress at once, across apps (RUNNER_MAX_CONCURRENT_RUNS_PER_USER). @default 2 */
  maxConcurrentPerUser?: number;
  /** Where finished runs are recorded. Defaults to a JSON line on stdout. */
  record?: RunRecorder;
  store?: RunStore;
  now?: () => Date;
  onError?: (error: Error) => void;
}

export const DEFAULT_MAX_CONCURRENT_PER_USER = 2;
/** Longest a `GET /v1/runs/:id?wait=` holds the request open, in seconds. */
export const MAX_WAIT_SECONDS = 60;

class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

const StartBody = z.object({
  graph: AppSlug,
  input: z.unknown().optional(),
  /** Name Monitoring lists the run under, e.g. the action that runs this graph. Defaults to the graph name. */
  action: z.string().trim().min(1).max(200).optional(),
  /** Service callers only: the env to run in (an app runtime runs in its own). */
  env: z.enum(['dev', 'prod']).optional(),
  /** Service callers only: on whose behalf the gateway starts the run. */
  caller: z.object({ kind: z.enum(['agent', 'app']), id: z.string().min(1).max(500).optional(), name: z.string().max(200).optional() }).optional(),
});

const BEARER = /^Bearer[ \t]+(\S+)$/i;

/** What `GET /v1/runs/:id` answers. The input is left out: it is the caller's own, and may be large. */
export function runView(run: Run) {
  return {
    id: run.id,
    app: run.app,
    env: run.env,
    graph: run.graph,
    action: run.action,
    status: run.status,
    caller: run.caller,
    output: run.output ?? null,
    error: run.error ?? null,
    trace: run.trace,
    costUsd: run.costUsd ?? null,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    ms: run.ms ?? null,
  };
}

export function createRunner(deps: RunnerDeps): Hono {
  const { driver } = deps;
  const now = deps.now ?? (() => new Date());
  const store = deps.store ?? createRunStore({ now });
  const record = deps.record ?? stdoutRecorder;
  const onError = deps.onError ?? ((error: Error) => console.error(error));
  const cap = deps.maxConcurrentPerUser ?? DEFAULT_MAX_CONCURRENT_PER_USER;

  async function caller(c: Context): Promise<CallerClaims> {
    const token = c.req.header(CALLER_HEADER);
    if (!token) throw new ApiError('forbidden_caller', `missing ${CALLER_HEADER} header`);
    let claims: CallerClaims;
    try {
      claims = await verifyCallerToken(token, deps.callerSecret);
    } catch (e) {
      throw new ApiError('forbidden_caller', e instanceof TokenError ? e.message : 'invalid caller token');
    }
    if (claims.kind === 'service' && !claims.svc) throw new ApiError('forbidden_caller', 'service caller token has no svc');
    return claims;
  }

  /** The audience is not checked, as in the Data API: a screen token and an assistant's MCP token both name the user and the app. */
  async function user(c: Context, app?: string): Promise<{ token: string; claims: KelayClaims }> {
    const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
    if (!token) throw new ApiError('unauthenticated', 'missing bearer token');
    try {
      return { token, claims: await verifyKelayToken(token, { jwks: deps.jwks, issuer: deps.issuer, ...(app ? { app } : {}) }) };
    } catch (e) {
      if (e instanceof TokenError) throw new ApiError('unauthenticated', e.message);
      throw e;
    }
  }

  function finish(run: Run, result: RunResult): void {
    run.finishedAt = now();
    run.ms = run.finishedAt.getTime() - run.startedAt.getTime();
    run.status = result.status;
    run.trace = result.trace;
    if (result.status === 'succeeded') run.output = result.output ?? null;
    if (result.error) run.error = result.error;
    if (result.costUsd !== undefined) run.costUsd = result.costUsd;
    store.emit(run, {
      type: 'run_finished',
      status: result.status,
      ms: run.ms,
      ...(result.status === 'succeeded' ? { output: run.output } : {}),
      ...(run.error ? { error: run.error } : {}),
    });
    void Promise.resolve()
      .then(() => record(toRecord(run)))
      .catch((e: unknown) => onError(new Error(`run ${run.id} was not recorded: ${(e as Error).message}`)));
  }

  /** The run, when the request's user started it and the calling component may speak for its app. */
  async function ownRun(c: Context): Promise<Run> {
    const from = await caller(c);
    const { claims } = await user(c);
    const run = store.get(c.req.param('id') ?? '');
    // Someone else's run answers like a missing one, so run ids cannot be probed.
    if (!run || run.sub !== claims.sub || run.app !== claims.app) throw new ApiError('not_found', 'no such run');
    if (from.kind === 'app-runtime' && from.app !== run.app) throw new ApiError('forbidden_caller', 'an app runtime may only read runs of its own app');
    return run;
  }

  const http = new Hono();

  http.get('/healthz', (c) => c.json({ ok: true, service: 'runner', driver: driver.name }));

  http.post('/v1/apps/:app/runs', async (c) => {
    const app = c.req.param('app');
    if (!AppSlug.safeParse(app).success) throw new ApiError('unknown_app', `no app "${app}"`);
    const from = await caller(c);
    if (from.kind === 'app-runtime' && from.app !== app) throw new ApiError('forbidden_caller', 'an app runtime may only start runs of its own app');
    const { token, claims } = await user(c, app);

    const parsed = StartBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) throw new ApiError('invalid_request', z.prettifyError(parsed.error));
    const body = parsed.data;
    if (from.kind === 'app-runtime' && (body.caller || body.env)) {
      throw new ApiError('invalid_request', 'only platform services may set caller or env; an app runtime starts runs for its own screen and env');
    }
    const startedBy: RunCaller = body.caller ?? { kind: 'user' };
    const env = from.kind === 'app-runtime' ? (from.env ?? 'prod') : (body.env ?? 'prod');

    if (store.running(claims.sub) >= cap) {
      throw new ApiError('rate_limited', `you already have ${cap} agent run${cap === 1 ? '' : 's'} in progress; wait for one to finish`, { 'Retry-After': '5' });
    }
    // The run takes its slot before the driver is asked, so two requests arriving together cannot both pass the cap.
    const run = store.create({
      id: crypto.randomUUID(),
      app,
      env,
      graph: body.graph,
      action: body.action ?? body.graph,
      sub: claims.sub,
      caller: startedBy,
      input: body.input ?? null,
      startedAt: now(),
    });
    store.emit(run, { type: 'run_started', runId: run.id, app, graph: run.graph });
    let started;
    try {
      started = await driver.start({ runId: run.id, app, env, graph: run.graph, input: run.input, userToken: token }, (event) => store.emit(run, event));
    } catch (e) {
      store.remove(run.id);
      if (e instanceof UnknownGraphError) throw new ApiError('not_found', e.message);
      throw e;
    }
    void started.done
      .catch((e: unknown): RunResult => ({ status: 'failed', error: { name: 'Kelay.DriverError', message: (e as Error).message }, trace: [] }))
      .then((result) => finish(run, result));
    return c.json({ runId: run.id }, 202);
  });

  http.get('/v1/runs/:id', async (c) => {
    const run = await ownRun(c);
    const wait = Number(c.req.query('wait') ?? 0);
    if (Number.isFinite(wait) && wait > 0) await store.wait(run.id, Math.min(wait, MAX_WAIT_SECONDS) * 1000);
    return c.json({ run: runView(run) });
  });

  http.get('/v1/runs/:id/events', async (c) => {
    const run = await ownRun(c);
    const after = Number(c.req.header('last-event-id') ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      let sent = after;
      let wake: (() => void) | undefined;
      const unsubscribe = store.subscribe(run.id, () => wake?.());
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      try {
        // Events are read from the run's own list, so nothing emitted between replay and subscribe is lost.
        for (;;) {
          // Read before draining: once the run is over its last event is already in the list.
          const over = run.status !== 'running';
          for (const event of run.events.slice(sent)) {
            const { seq, type, ...data } = event;
            await stream.writeSSE({ id: String(seq), event: type, data: JSON.stringify(data) });
            sent = seq;
          }
          if (over || stream.aborted) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (run.events.length > sent) resolve();
          });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  http.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found.' } } satisfies ErrorResponse, 404));

  http.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message } } satisfies ErrorResponse, HTTP_STATUS[err.code] as ContentfulStatusCode, err.headers);
    }
    onError(err);
    return c.json({ error: { code: 'internal', message: 'internal error' } } satisfies ErrorResponse, 500);
  });

  return http;
}
