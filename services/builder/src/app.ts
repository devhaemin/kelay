// HTTP API of the Builder (port 4006). Every route takes the builder's Kelay ID token for the console,
// as the Control API's builder routes do, and the Control API decides whether they own the app.
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import type { Logger } from 'pino';
import { z } from 'zod';
import { AppSlug, audienceForApp, type KelayClaims } from '@kelay/contracts';
import { verifyKelayToken, type VerifyOptions } from '@kelay/tokens';
import type { AppInfo, ControlApi } from './control.ts';
import { ApiError, errorBody } from './errors.ts';
import type { WorkspaceEvent } from './events.ts';
import type { WorkspaceManager } from './workspaces.ts';

export const CONSOLE_APP = 'kelay-console';
const BUILDER_ROLES = ['builder', 'admin'];
const KEEP_ALIVE_MS = 15_000;

export interface BuilderApiDeps {
  auth: { issuer: string; jwks: VerifyOptions['jwks'] };
  control: ControlApi;
  workspaces: WorkspaceManager;
  logger: Logger;
}

type Env = { Variables: { builder: KelayClaims; token: string; app: AppInfo } };

const hook = (result: { success: boolean; error?: unknown }) => {
  if (!result.success) throw new ApiError('invalid_request', z.prettifyError(result.error as z.ZodError));
};

const StartBody = z.object({ app: AppSlug, prompt: z.string().trim().min(1).max(4000) });
const MessageBody = z.object({ text: z.string().trim().min(1).max(4000), context: z.string().trim().max(200).optional() });
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).optional(), format: z.enum(['sse', 'json']).optional() });

export function createBuilderApi(deps: BuilderApiDeps): Hono<Env> {
  const { control, workspaces, logger } = deps;
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err.code, err.message), err.status);
    if (err instanceof HTTPException && err.status < 500) return c.json(errorBody(err.status === 401 ? 'unauthenticated' : 'invalid_request', err.message || 'bad request'), err.status);
    logger.error({ type: 'error', err, path: c.req.path }, 'unhandled error');
    return c.json(errorBody('internal', 'internal error'), 500);
  });
  app.notFound((c) => c.json(errorBody('not_found', `no route ${c.req.method} ${c.req.path}`), 404));

  app.get('/healthz', (c) => c.json({ ok: true, service: 'builder', driver: workspaces.driver, agent: workspaces.agent }));

  const builder = createMiddleware<Env>(async (c, next) => {
    const token = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) throw new ApiError('unauthenticated', 'missing bearer token');
    let claims: KelayClaims;
    try {
      claims = await verifyKelayToken(token, { jwks: deps.auth.jwks, issuer: deps.auth.issuer, app: CONSOLE_APP, audience: audienceForApp(CONSOLE_APP) });
    } catch (e) {
      throw new ApiError('unauthenticated', (e as Error).message);
    }
    if (!BUILDER_ROLES.includes(claims.role)) throw new ApiError('denied', 'builder role required');
    c.set('builder', claims);
    c.set('token', token);
    await next();
  });

  /** Loads the app through the Control API with the builder's own token: `denied` unless they own it. */
  const owned = createMiddleware<Env>(async (c, next) => {
    const slug = AppSlug.safeParse(c.req.param('app'));
    if (!slug.success) throw new ApiError('unknown_app', 'unknown app');
    c.set('app', await control.appFor(c.get('token'), slug.data));
    await next();
  });

  const statusOf = async (slug: string) => {
    const status = await workspaces.status(slug);
    if (!status) throw new ApiError('not_found', 'This app has no Builder workspace yet.');
    return status;
  };

  app.post('/v1/workspaces', builder, zValidator('json', StartBody, hook), async (c) => {
    const body = c.req.valid('json');
    const info = await control.appFor(c.get('token'), body.app);
    const { turn } = await workspaces.start(info, c.get('builder').sub, body.prompt);
    logger.info({ type: 'workspace_started', app: info.slug, turn }, 'first build started');
    return c.json({ workspace: await statusOf(info.slug), turn }, 202);
  });

  app.get('/v1/workspaces/:app', builder, owned, async (c) => c.json({ workspace: await statusOf(c.get('app').slug) }));

  app.post('/v1/workspaces/:app/messages', builder, owned, zValidator('json', MessageBody, hook), async (c) => {
    const body = c.req.valid('json');
    const { turn } = await workspaces.message(c.get('app').slug, c.get('builder').sub, body.text, body.context ?? null);
    return c.json({ workspace: await statusOf(c.get('app').slug), turn }, 202);
  });

  // The transcript so far, then live events. `Last-Event-ID` (or `?after=`) resumes after a reconnect.
  app.get('/v1/workspaces/:app/events', builder, owned, zValidator('query', EventsQuery, hook), async (c) => {
    const slug = c.get('app').slug;
    await statusOf(slug);
    const query = c.req.valid('query');
    const after = query.after ?? (Number(c.req.header('last-event-id')) || 0);
    const log = workspaces.events(slug);
    if (query.format === 'json') return c.json({ events: log.since(after) });

    return streamSSE(c, async (stream) => {
      const pending: WorkspaceEvent[] = [];
      let wake: (() => void) | null = null;
      // Subscribed before the backlog is read, so no event falls between the two.
      const unsubscribe = log.subscribe((event) => {
        pending.push(event);
        wake?.();
      });
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      try {
        let sent = after;
        const send = async (event: WorkspaceEvent) => {
          if (event.id <= sent) return;
          sent = event.id;
          await stream.writeSSE({ id: String(event.id), event: event.type, data: JSON.stringify(event) });
        };
        for (const event of log.since(after)) await send(event);
        while (!closed) {
          while (pending.length > 0) await send(pending.shift()!);
          const woken = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), KEEP_ALIVE_MS);
            wake = () => {
              clearTimeout(timer);
              resolve(true);
            };
          });
          wake = null;
          if (!woken && !closed) await stream.writeSSE({ event: 'ping', data: '{}' });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
