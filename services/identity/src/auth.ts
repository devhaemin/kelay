// better-auth configuration for Kelay ID (contract §8).
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource as nodeFetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import {
  getOAuthProviderState,
  type ClientMetadataResourceFetch,
  type OAuthProviderExtension,
} from '@better-auth/oauth-provider';
import type { Pool } from 'pg';
import type { AppResources } from './apps.ts';
import { mayUseApp, type MemberStore } from './members.ts';

export const SOCIAL_PROVIDERS = { google: 'Google', kakao: 'Kakao', github: 'GitHub' } as const;
export type SocialProvider = keyof typeof SOCIAL_PROVIDERS;
export interface SocialCredentials {
  clientId: string;
  clientSecret: string;
}
export type SocialConfig = Partial<Record<SocialProvider, SocialCredentials>>;

/** Reads `<PROVIDER>_CLIENT_ID` / `<PROVIDER>_CLIENT_SECRET`; a provider is enabled only when both are set. */
export function socialFromEnv(env: Record<string, string | undefined>): SocialConfig {
  const social: SocialConfig = {};
  for (const provider of Object.keys(SOCIAL_PROVIDERS) as SocialProvider[]) {
    const clientId = env[`${provider.toUpperCase()}_CLIENT_ID`];
    const clientSecret = env[`${provider.toUpperCase()}_CLIENT_SECRET`];
    if (clientId && clientSecret) social[provider] = { clientId, clientSecret };
  }
  return social;
}

/**
 * Scopes MCP clients may request. `openid` is left out on purpose: with it, the provider adds its
 * userinfo endpoint to `aud`, and MCP tokens must carry exactly the app's resource URL (contract §4).
 */
export const MCP_SCOPES = ['offline_access'];

export interface AuthDeps {
  database: Pool;
  /** KELAY_ID_ISSUER without a trailing slash; also better-auth's baseURL. */
  issuer: string;
  secret: string;
  /** MCP_PUBLIC_BASE_URL. */
  mcpPublicBaseUrl: string;
  apps: AppResources;
  members: MemberStore;
  emailPassword: boolean;
  social: SocialConfig;
  fetchClientMetadataResource?: ClientMetadataResourceFetch;
  trustedOrigins?: string[];
  /** Header that carries the client IP for rate limiting; unset keeps better-auth's x-forwarded-for. */
  clientIpHeader?: string;
}

const invalidGrant = (description: string) =>
  new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: description });

/**
 * The options alone, so migrations can read the schema without an instance: `betterAuth()` starts
 * its context and queries the database as soon as it is called.
 */
export function authOptions(deps: AuthDeps) {
  const { apps, members, issuer } = deps;
  // mcp() needs one resource even before the first app is published. `/mcp` alone can never be an
  // app's resource (those are /<handle>/<app>/mcp), so no token is ever issued for the placeholder:
  // `appClaims` below refuses every resource that is not an app's.
  const primary = apps.list[0]?.resource ?? `${deps.mcpPublicBaseUrl.replace(/\/+$/, '')}/mcp`;

  // Runs on every authorization_code and refresh_token grant, so a ban or a revoked consent
  // stops the assistant at its next refresh. Revoking in the control API deletes the consent
  // row and leaves refresh tokens valid, which is why the row is looked up here.
  const appClaims: OAuthProviderExtension = {
    claims: {
      async accessToken({ ctx, user, client, resources, referenceId }) {
        const target = apps.single(resources);
        if (!user || !target || target.app !== referenceId) {
          throw invalidGrant('a token must be bound to exactly one Kelay app');
        }
        if (!client.skipConsent) {
          const consent = await ctx.context.adapter.findOne({
            model: 'oauthConsent',
            where: [
              { field: 'clientId', value: client.clientId },
              { field: 'userId', value: user.id },
              { field: 'referenceId', value: target.app },
            ],
          });
          if (!consent) throw invalidGrant(`consent for ${target.app} was revoked`);
        }
        const member = await members.find(target.app, user.id);
        if (!mayUseApp(member)) throw invalidGrant(`not a member of ${target.app}`);
        return { app: target.app, org: member.org, role: member.role, plan: member.plan };
      },
    },
  };

  return {
    baseURL: issuer,
    secret: deps.secret,
    database: deps.database,
    ...(deps.trustedOrigins ? { trustedOrigins: deps.trustedOrigins } : {}),
    // Rate limits are per client IP. Behind Cloudflare and the ALB, x-forwarded-for is a chain whose first
    // entry the client chooses, so better-auth finds no IP it can trust there and limits nothing.
    ...(deps.clientIpHeader ? { advanced: { ipAddress: { ipAddressHeaders: [deps.clientIpHeader] } } } : {}),
    disabledPaths: [
      // The jwt plugin's session-token route would mint JWTs a resource server could mistake for access tokens.
      '/token',
      // Consents are revoked in the control API, which deletes Kelay ID's row with its own. Revoking
      // here would leave the control API listing an assistant that no longer has access.
      '/oauth2/delete-consent',
    ],
    emailAndPassword: { enabled: deps.emailPassword },
    socialProviders: deps.social,
    plugins: [
      jwt({ disableSettingJwtHeader: true, jwt: { issuer } }),
      mcp({
        loginPage: `${issuer}/login`,
        consentPage: `${issuer}/consent`,
        // mcp() takes one resource; every other app's resource comes in through `resources`.
        resource: primary,
        resources: apps.list.map((a) => ({
          identifier: a.resource,
          name: `${a.handle}/${a.app}`,
          metadata: { app: a.app, handle: a.handle },
        })),
        clientRegistrationDefaultResources: apps.list.map((a) => a.resource),
        scopes: MCP_SCOPES,
        grantTypes: ['authorization_code', 'refresh_token'],
        postLogin: {
          page: `${issuer}/login`,
          shouldRedirect: () => false,
          // The provider keeps one consent row per (client, user, reference) and overwrites its
          // resources on every consent. Keying the reference by app keeps consent per app.
          async consentReferenceId() {
            const state = await getOAuthProviderState();
            const target = apps.single(new URLSearchParams(state?.query ?? '').getAll('resource'));
            if (!target) {
              throw new APIError('BAD_REQUEST', {
                error: 'invalid_target',
                error_description: 'request exactly one Kelay app MCP resource',
              });
            }
            return target.app;
          },
        },
        extensions: [appClaims],
      }),
      cimd({
        fetchClientMetadataResource: deps.fetchClientMetadataResource ?? nodeFetchClientMetadataResource,
        metadataProfile: 'mcp-2026-07-28',
      }),
    ],
  } satisfies BetterAuthOptions;
}

export const createAuth = (deps: AuthDeps) => betterAuth(authOptions(deps));

export type KelayAuth = ReturnType<typeof createAuth>;
