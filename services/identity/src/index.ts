// Kelay ID (contract §8): better-auth on Hono, app-scoped tokens and MCP authorization.
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getMigrations } from 'better-auth/db/migration';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  AppSlug,
  HTTP_STATUS,
  audienceForApp,
  type ErrorCode,
  type ErrorResponse,
} from '@kelay/contracts';
import { appResources, type AppDirectory } from './apps.ts';
import { authOptions, createAuth, type AuthDeps, type SocialConfig, type SocialProvider } from './auth.ts';
import { CONSOLE_APP, mayBecomeBuilder, type BuilderSignup } from './builders.ts';
import type { ConsentRecorder } from './consents.ts';
import { mayUseApp, pgMemberStore, type MemberStore } from './members.ts';
import { pageRoutes } from './pages.ts';

export { mcpResourceUrl, type AppDirectory, type AppResource, type AppResources } from './apps.ts';
export { MCP_SCOPES, SOCIAL_PROVIDERS, socialFromEnv, type KelayAuth, type SocialConfig } from './auth.ts';
export { CONSOLE_APP, builderSignupFromEnv, controlApiBuilders, mayBecomeBuilder, type BuilderSignup, type ControlApiBuildersOptions } from './builders.ts';
export { controlApiConsents, type ConsentRecord, type ConsentRecorder, type ControlApiConsentsOptions } from './consents.ts';
export { pgMemberStore, type MemberStore } from './members.ts';
export { createReloadingIdentity, type ReloadingIdentity, type ReloadingIdentityOptions } from './reloading.ts';

export interface IdentityDeps {
  /** Control DB pool: better-auth's tables live here, and `app_members` is read from it. */
  database: Pool;
  /** KELAY_ID_ISSUER: the public origin of Kelay ID and the `iss` of every token. */
  issuer: string;
  secret: string;
  /** The apps people can connect assistants to. It is fixed for the life of the instance; see `createReloadingIdentity`. */
  registry: AppDirectory;
  /** MCP_PUBLIC_BASE_URL: app MCP resources are `<base>/<handle>/<app>/mcp`. */
  mcpPublicBaseUrl: string;
  /** @default true */
  emailPassword?: boolean;
  social?: SocialConfig;
  /** Transport for CIMD documents. Defaults to the plugin's DNS-pinning Node transport. */
  fetchClientMetadataResource?: ClientMetadataResourceFetch;
  trustedOrigins?: string[];
  /** Defaults to reading `app_members` from `database`. */
  members?: MemberStore;
  /**
   * Other origins whose pages may call `POST /v1/token` with the person's session cookie, e.g. the
   * console. The issuer's own origin always may. @default none
   */
  corsOrigins?: string[];
  /**
   * Lets `/login?return_to=` send the browser back to any loopback origin, besides Kelay ID's own
   * origin and `corsOrigins`. For local development, where dev previews listen on a free port. @default false
   */
  returnLoopback?: boolean;
  /**
   * Request header that holds the client IP, for better-auth's rate limits. Set it to the single-value
   * header the edge writes (`cf-connecting-ip` behind Cloudflare). Trust it only when clients cannot
   * reach the service except through that edge. Unset reads x-forwarded-for.
   */
  clientIpHeader?: string;
  /**
   * Records each consent a person grants an assistant, normally `controlApiConsents`. A consent the
   * recorder refuses is not granted. Unset keeps consents in Kelay ID only (tests, a stack without a control API).
   */
  consents?: ConsentRecorder;
  /**
   * Who becomes a builder by signing up (the first-builder bootstrap). Unset, nobody does: builders
   * are then only the people `app_members` already lists for `kelay-console`.
   */
  builders?: BuilderSignup;
  /**
   * Parent domain for the session cookie (`kelay.app` for `id.kelay.app`). The console exchanges the
   * session for its token on its own server, so the browser must send the cookie to the console's
   * host too. Unset, the cookie is for Kelay ID's host only, which is enough when both are `localhost`.
   */
  cookieDomain?: string;
}

const TokenRequest = z.object({ app: AppSlug });

function fail(c: Context, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } } satisfies ErrorResponse, HTTP_STATUS[code] as ContentfulStatusCode);
}

/** Makes the person a builder when the sign-up rules say so. Idempotent for someone who has no membership yet. */
async function enrollBuilder(builders: BuilderSignup | undefined, user: { id: string; email: string; emailVerified: boolean }): Promise<boolean> {
  if (!builders || !mayBecomeBuilder(builders, user)) return false;
  await builders.enroll(user.id);
  return true;
}

function resolveDeps(deps: IdentityDeps): AuthDeps {
  // Pages of these origins already call /v1/token with the session cookie; better-auth takes its
  // own POSTs (sign-out from the console's server) from them as well.
  const trustedOrigins = [...(deps.trustedOrigins ?? []), ...(deps.corsOrigins ?? [])];
  return {
    database: deps.database,
    issuer: deps.issuer.replace(/\/+$/, ''),
    secret: deps.secret,
    mcpPublicBaseUrl: deps.mcpPublicBaseUrl,
    apps: appResources(deps.registry, deps.mcpPublicBaseUrl),
    members: deps.members ?? pgMemberStore(deps.database),
    emailPassword: deps.emailPassword ?? true,
    social: deps.social ?? {},
    ...(deps.fetchClientMetadataResource ? { fetchClientMetadataResource: deps.fetchClientMetadataResource } : {}),
    ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    ...(deps.clientIpHeader ? { clientIpHeader: deps.clientIpHeader.toLowerCase() } : {}),
    ...(deps.cookieDomain ? { cookieDomain: deps.cookieDomain } : {}),
    ...(deps.builders ? { onUserCreated: async (user) => void (await enrollBuilder(deps.builders, user)) } : {}),
  };
}

/**
 * Creates or updates better-auth's tables (users, sessions, JWKS, OAuth clients, consents, ...).
 * Run it before `createIdentity`, whose instance starts reading those tables as soon as it exists.
 */
export async function migrateIdentity(deps: IdentityDeps): Promise<void> {
  const { runMigrations } = await getMigrations(authOptions(resolveDeps(deps)));
  await runMigrations();
}

export function createIdentity(deps: IdentityDeps) {
  const resolved = resolveDeps(deps);
  const { issuer, apps, members, emailPassword, social } = resolved;
  const auth = createAuth(resolved);

  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
  // RFC 8414 metadata for the issuer. Protected resource metadata (RFC 9728) is served by the MCP
  // gateway at each resource's own origin (contract §7), so the identity host does not publish it.
  app.on(['GET', 'HEAD'], '/.well-known/oauth-authorization-server', (c) => auth.handler(c.req.raw));

  // The session cookie is what authenticates this route, so which pages may use it is decided here:
  // listed origins get CORS headers, and a browser request from any other origin is refused outright
  // rather than left to the browser to block. Callers that send no Origin (servers, CLIs) are unaffected.
  const tokenOrigins = new Set([new URL(issuer).origin, ...(deps.corsOrigins ?? []).map((o) => new URL(o).origin)]);
  app.use(
    '/v1/token',
    cors({
      origin: (origin) => (tokenOrigins.has(origin) ? origin : null),
      credentials: true,
      allowMethods: ['POST'],
      allowHeaders: ['content-type'],
      maxAge: 600,
    }),
  );

  app.post('/v1/token', async (c) => {
    const origin = c.req.header('origin');
    if (origin && !tokenOrigins.has(origin)) return fail(c, 'denied', `${origin} may not request tokens`);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return fail(c, 'unauthenticated', 'sign in to Kelay ID first');
    const body = TokenRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, 'invalid_request', 'body must be { "app": "<app slug>" }');
    const slug = body.data.app;
    let member = await members.find(slug, session.user.id);
    // Normally the sign-up made them a builder. This covers a sign-up the control API missed, and an
    // email that was put on the allowlist, or verified, after its owner signed up.
    if (!member && slug === CONSOLE_APP) {
      const enrolled = await enrollBuilder(deps.builders, session.user).catch((e: Error) => {
        console.error(JSON.stringify({ type: 'builder_enroll_failed', user: session.user.id, message: e.message }));
        return false;
      });
      if (enrolled) member = await members.find(slug, session.user.id);
    }
    if (!mayUseApp(member)) return fail(c, 'denied', `not a member of ${slug}`);
    const { token } = await auth.api.signJWT({
      body: {
        payload: {
          sub: session.user.id,
          aud: audienceForApp(slug),
          iat: Math.floor(Date.now() / 1000),
          app: slug,
          org: member.org,
          role: member.role,
          plan: member.plan,
        },
      },
    });
    return c.json({ token });
  });

  app.route(
    '/',
    pageRoutes({
      auth,
      issuer,
      secret: deps.secret,
      apps,
      members,
      emailPassword,
      social: Object.keys(social) as SocialProvider[],
      returnOrigins: [...tokenOrigins],
      returnLoopback: deps.returnLoopback ?? false,
      ...(deps.consents ? { consents: deps.consents } : {}),
      ...(resolved.clientIpHeader ? { clientIpHeader: resolved.clientIpHeader } : {}),
    }),
  );

  return { app, auth, apps, issuer };
}

export type Identity = ReturnType<typeof createIdentity>;
