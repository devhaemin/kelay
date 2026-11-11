// Who may call what (docs/contracts.md §4):
// - builder routes: a Kelay ID token for the console app with role builder|admin; ownership is checked per app;
// - end-user routes: an app-scoped token for :app plus an app-runtime caller token for the same app;
// - internal routes: a `service` caller token.
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { CALLER_HEADER, audienceForApp, type CallerClaims, type KelayClaims } from '@kelay/contracts';
import { verifyCallerToken, verifyKelayToken, type VerifyOptions } from '@kelay/tokens';
import { ApiError } from './errors.ts';

export const CONSOLE_APP = 'kelay-console';
export const BUILDER_ROLES: readonly string[] = ['builder', 'admin'];

export interface AuthConfig {
  issuer: string;
  jwks: VerifyOptions['jwks'];
  callerSecret: string;
}

export type Principal =
  | { kind: 'builder'; user: KelayClaims }
  | { kind: 'service'; caller: CallerClaims }
  | { kind: 'user'; user: KelayClaims; caller?: CallerClaims };

export type AppEnv = { Variables: { principal: Principal } };

function bearer(header: string | undefined): string {
  const m = header?.match(/^Bearer\s+(\S+)$/i);
  if (!m?.[1]) throw new ApiError('unauthenticated', 'missing bearer token');
  return m[1];
}

async function userToken(cfg: AuthConfig, header: string | undefined, app?: string): Promise<KelayClaims> {
  const token = bearer(header);
  try {
    return await verifyKelayToken(token, {
      jwks: cfg.jwks,
      issuer: cfg.issuer,
      ...(app ? { app, audience: audienceForApp(app) } : {}),
    });
  } catch (e) {
    throw new ApiError('unauthenticated', (e as Error).message);
  }
}

async function callerToken(cfg: AuthConfig, header: string | undefined): Promise<CallerClaims> {
  if (!header) throw new ApiError('forbidden_caller', `missing ${CALLER_HEADER}`);
  try {
    return await verifyCallerToken(header, cfg.callerSecret);
  } catch (e) {
    throw new ApiError('forbidden_caller', (e as Error).message);
  }
}

async function builder(cfg: AuthConfig, header: string | undefined): Promise<Principal> {
  const user = await userToken(cfg, header, CONSOLE_APP);
  if (!BUILDER_ROLES.includes(user.role)) throw new ApiError('denied', 'builder role required');
  return { kind: 'builder', user };
}

async function service(cfg: AuthConfig, header: string | undefined): Promise<Principal> {
  const caller = await callerToken(cfg, header);
  if (caller.kind !== 'service') throw new ApiError('forbidden_caller', 'service caller required');
  return { kind: 'service', caller };
}

export function requireBuilder(cfg: AuthConfig): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set('principal', await builder(cfg, c.req.header('authorization')));
    await next();
  });
}

export function requireService(cfg: AuthConfig): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set('principal', await service(cfg, c.req.header(CALLER_HEADER)));
    await next();
  });
}

/** Scheduled work (triage, daily report, deploys from improvement runs) may come from a platform service instead. */
export function requireBuilderOrService(cfg: AuthConfig): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const callerHeader = c.req.header(CALLER_HEADER);
    const principal =
      callerHeader && !c.req.header('authorization')
        ? await service(cfg, callerHeader)
        : await builder(cfg, c.req.header('authorization'));
    c.set('principal', principal);
    await next();
  });
}

/** End-user routes under /v1/apps/:app: the user token and the app-runtime caller must both be for :app. */
export function requireAppUser(cfg: AuthConfig): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const app = c.req.param('app');
    if (!app) throw new ApiError('invalid_request', 'missing app');
    const user = await userToken(cfg, c.req.header('authorization'), app);
    const caller = await callerToken(cfg, c.req.header(CALLER_HEADER));
    if (caller.kind !== 'app-runtime' || caller.app !== app) {
      throw new ApiError('forbidden_caller', 'caller must be the app runtime of this app');
    }
    c.set('principal', { kind: 'user', user, caller });
    await next();
  });
}

/**
 * Routes about the signed-in person (/v1/me). A console token sees everything the person owns;
 * an app-scoped token is limited to its app and must come through that app's runtime.
 */
export function requireUser(cfg: AuthConfig): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = await userToken(cfg, c.req.header('authorization'));
    const aud = Array.isArray(user.aud) ? user.aud : [user.aud];
    if (!aud.includes(audienceForApp(user.app))) throw new ApiError('unauthenticated', 'token audience does not match its app');
    if (user.app === CONSOLE_APP) {
      c.set('principal', { kind: 'user', user });
    } else {
      const caller = await callerToken(cfg, c.req.header(CALLER_HEADER));
      if (caller.kind !== 'app-runtime' || caller.app !== user.app) {
        throw new ApiError('forbidden_caller', 'caller must be the app runtime of the token app');
      }
      c.set('principal', { kind: 'user', user, caller });
    }
    await next();
  });
}
