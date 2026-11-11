// Kelay ID (contract §8): better-auth on Hono, app-scoped tokens and MCP authorization.
import { Hono, type Context } from 'hono';
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
import { createAuth, type SocialConfig, type SocialProvider } from './auth.ts';
import { mayUseApp, pgMemberStore, type MemberStore } from './members.ts';
import { pageRoutes } from './pages.ts';

export { mcpResourceUrl, type AppResource, type AppResources } from './apps.ts';
export { MCP_SCOPES, SOCIAL_PROVIDERS, socialFromEnv, type KelayAuth, type SocialConfig } from './auth.ts';
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
}

const TokenRequest = z.object({ app: AppSlug });

function fail(c: Context, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } } satisfies ErrorResponse, HTTP_STATUS[code] as ContentfulStatusCode);
}

export function createIdentity(deps: IdentityDeps) {
  const issuer = deps.issuer.replace(/\/+$/, '');
  const apps = appResources(deps.registry, deps.mcpPublicBaseUrl);
  const members = deps.members ?? pgMemberStore(deps.database);
  const social = deps.social ?? {};
  const emailPassword = deps.emailPassword ?? true;
  const auth = createAuth({
    database: deps.database,
    issuer,
    secret: deps.secret,
    apps,
    members,
    emailPassword,
    social,
    ...(deps.fetchClientMetadataResource ? { fetchClientMetadataResource: deps.fetchClientMetadataResource } : {}),
    ...(deps.trustedOrigins ? { trustedOrigins: deps.trustedOrigins } : {}),
  });

  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
  // RFC 8414 metadata for the issuer. Protected resource metadata (RFC 9728) is served by the MCP
  // gateway at each resource's own origin (contract §7), so the identity host does not publish it.
  app.on(['GET', 'HEAD'], '/.well-known/oauth-authorization-server', (c) => auth.handler(c.req.raw));

  app.post('/v1/token', async (c) => {
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
    }),
  );

  return {
    app,
    auth,
    apps,
    issuer,
    /** Creates or updates better-auth's tables (users, sessions, JWKS, OAuth clients, consents, ...). */
    async migrate() {
      const { runMigrations } = await getMigrations(auth.options);
      await runMigrations();
    },
  };
}

export type Identity = ReturnType<typeof createIdentity>;
