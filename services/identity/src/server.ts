// Kelay ID process entry: reads env, migrates better-auth's tables, serves on PORT (default 4001).
import { serve } from '@hono/node-server';
import pg from 'pg';
import { LOCAL_PORTS } from '@kelay/contracts';
import { loadAppRegistry } from '@kelay/contracts/registry';
import { controlApiConsents, createIdentity, migrateIdentity, socialFromEnv, type IdentityDeps } from './index.ts';

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

const database = new pg.Pool({ connectionString: required('CONTROL_DATABASE_URL') });
const deps: IdentityDeps = {
  database,
  issuer: required('KELAY_ID_ISSUER'),
  secret: production ? required('BETTER_AUTH_SECRET') : (env.BETTER_AUTH_SECRET ?? 'kelay-identity-dev-secret-not-for-production'),
  registry: loadAppRegistry(required('KELAY_APPS_FILE')),
  mcpPublicBaseUrl: required('MCP_PUBLIC_BASE_URL'),
  emailPassword: !production || env.KELAY_ID_EMAIL_PASSWORD === 'true',
  social: socialFromEnv(env),
  corsOrigins: list(env.KELAY_ID_CORS_ORIGINS),
  ...(clientIpHeader ? { clientIpHeader } : {}),
  ...(controlApiUrl && callerSecret ? { consents: controlApiConsents({ controlApiUrl, callerSecret }) } : {}),
};

await migrateIdentity(deps);
const identity = createIdentity(deps);

const server = serve({ fetch: identity.app.fetch, port: Number(env.PORT ?? LOCAL_PORTS.identity) }, (info) => {
  console.log(JSON.stringify({ type: 'listening', service: 'identity', port: info.port, issuer: identity.issuer }));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => void database.end().finally(() => process.exit(0)));
  });
}
