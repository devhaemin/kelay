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
  type AppRegistry,
  type ErrorCode,
  type ErrorResponse,
} from '@kelay/contracts';
import { appResources } from './apps.ts';
import { authOptions, createAuth, type AuthDeps, type SocialConfig, type SocialProvider } from './auth.ts';
import type { ConsentRecorder } from './consents.ts';
import { mayUseApp, pgMemberStore, type MemberStore } from './members.ts';
import { pageRoutes } from './pages.ts';

export { mcpResourceUrl, type AppResource, type AppResources } from './apps.ts';
export { MCP_SCOPES, SOCIAL_PROVIDERS, socialFromEnv, type KelayAuth, type SocialConfig } from './auth.ts';
export { controlApiConsents, type ConsentRecord, type ConsentRecorder, type ControlApiConsentsOptions } from './consents.ts';
export { pgMemberStore, type MemberStore } from './members.ts';

export interface IdentityDeps {
  /** Control DB pool: better-auth's tables live here, and `app_members` is read from it. */
  database: Pool;
  /** KELAY_ID_ISSUER: the public origin of Kelay ID and the `iss` of every token. */
  issuer: string;
  secret: string;
  registry: AppRegistry;
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
}

const TokenRequest = z.object({ app: AppSlug });

function fail(c: Context, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } } satisfies ErrorResponse, HTTP_STATUS[code] as ContentfulStatusCode);
}

function resolveDeps(deps: IdentityDeps): AuthDeps {
  return {
    database: deps.database,
    issuer: deps.issuer.replace(/\/+$/, ''),
    secret: deps.secret,
    apps: appResources(deps.registry, deps.mcpPublicBaseUrl),
    members: deps.members ?? pgMemberStore(deps.database),
    emailPassword: deps.emailPassword ?? true,
    social: deps.social ?? {},
    ...(deps.fetchClientMetadataResource ? { fetchClientMetadataResource: deps.fetchClientMetadataResource } : {}),
    ...(deps.trustedOrigins ? { trustedOrigins: deps.trustedOrigins } : {}),
    ...(deps.clientIpHeader ? { clientIpHeader: deps.clientIpHeader.toLowerCase() } : {}),
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
    const member = await members.find(slug, session.user.id);
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
      ...(deps.consents ? { consents: deps.consents } : {}),
      ...(resolved.clientIpHeader ? { clientIpHeader: resolved.clientIpHeader } : {}),
    }),
  );

  return { app, auth, apps, issuer };
}

export type Identity = ReturnType<typeof createIdentity>;
