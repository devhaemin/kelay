// Kelay ID process entry: reads env, migrates better-auth's tables, serves on PORT (default 4001).
import { serve } from '@hono/node-server';
import pg from 'pg';
import { LOCAL_PORTS, databaseCredentialsFromEnv, databaseUrlWithCredentials } from '@kelay/contracts';
import { registrySourceFromEnv } from '@kelay/contracts/registry';
import { signCallerToken } from '@kelay/tokens';
import { builderSignupFromEnv, controlApiBuilders, controlApiConsents, createReloadingIdentity, migrateIdentity, socialFromEnv, type IdentityDeps } from './index.ts';

const env = process.env;
const production = env.NODE_ENV === 'production';

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`identity: ${name} is required`);
  return value;
}

// Consents are recorded in the control API. Production refuses to start without it; a local Kelay ID
// run on its own keeps consents to itself.
const controlApiUrl = production ? required('CONTROL_API_URL') : env.CONTROL_API_URL;
const callerSecret = production ? required('KELAY_CALLER_SECRET') : env.KELAY_CALLER_SECRET;

const list = (value: string | undefined) => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
// In production the service sits behind Cloudflare and an ALB that only Cloudflare can reach
// (docs/deploy.md), so the client IP is the one Cloudflare reports.
const clientIpHeader = env.KELAY_ID_CLIENT_IP_HEADER ?? (production ? 'cf-connecting-ip' : undefined);

// Apps come from KELAY_APPS_FILE, or from the control API with KELAY_APPS_SOURCE=control-api (contract §6).
const registry = registrySourceFromEnv(env, {
  callerToken: () => signCallerToken({ kind: 'service', svc: 'identity' }, required('KELAY_CALLER_SECRET')),
});
const refreshSeconds = Number(env.KELAY_APPS_TTL_SECONDS ?? 30);

// The first-builder bootstrap: who becomes a builder by signing up. The membership is written by the control API.
const signup = builderSignupFromEnv(env);
const signupOn = signup.open || signup.allowlist.length > 0;
if (signupOn && !(controlApiUrl && callerSecret)) throw new Error('identity: KELAY_BUILDER_ALLOWLIST and KELAY_OPEN_SIGNUP need CONTROL_API_URL and KELAY_CALLER_SECRET');

const database = new pg.Pool({ connectionString: databaseUrlWithCredentials(required('CONTROL_DATABASE_URL'), databaseCredentialsFromEnv(env)) });
const deps: Omit<IdentityDeps, 'registry'> = {
  database,
  issuer: required('KELAY_ID_ISSUER'),
  secret: production ? required('BETTER_AUTH_SECRET') : (env.BETTER_AUTH_SECRET ?? 'kelay-identity-dev-secret-not-for-production'),
  mcpPublicBaseUrl: required('MCP_PUBLIC_BASE_URL'),
  emailPassword: !production || env.KELAY_ID_EMAIL_PASSWORD === 'true',
  social: socialFromEnv(env),
  corsOrigins: list(env.KELAY_ID_CORS_ORIGINS),
  returnLoopback: !production,
  ...(clientIpHeader ? { clientIpHeader } : {}),
  ...(env.KELAY_ID_COOKIE_DOMAIN ? { cookieDomain: env.KELAY_ID_COOKIE_DOMAIN } : {}),
  ...(controlApiUrl && callerSecret ? { consents: controlApiConsents({ controlApiUrl, callerSecret }) } : {}),
  // A production build has no email verification, so there only a provider-verified email matches the allowlist.
  ...(signupOn && controlApiUrl && callerSecret ? { builders: { ...signup, requireVerifiedEmail: production, enroll: controlApiBuilders({ controlApiUrl, callerSecret }) } } : {}),
};

// The tables do not depend on which apps exist.
await migrateIdentity({ ...deps, registry: { apps: {} } });
const identity = await createReloadingIdentity(deps, {
  source: registry,
  refreshMs: refreshSeconds * 1000,
  onError: (error) => console.error(JSON.stringify({ type: 'registry_error', service: 'identity', message: error.message })),
  onReload: (apps) => console.log(JSON.stringify({ type: 'apps', service: 'identity', count: apps.length })),
});

const server = serve({ fetch: identity.fetch, port: Number(env.PORT ?? LOCAL_PORTS.identity) }, (info) => {
  console.log(JSON.stringify({ type: 'listening', service: 'identity', port: info.port, issuer: deps.issuer, apps: registry.kind }));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    identity.stop();
    server.close(() => void database.end().finally(() => process.exit(0)));
  });
}
