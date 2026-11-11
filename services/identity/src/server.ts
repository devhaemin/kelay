// Kelay ID process entry: reads env, migrates better-auth's tables, serves on PORT (default 4001).
import { serve } from '@hono/node-server';
import pg from 'pg';
import { LOCAL_PORTS } from '@kelay/contracts';
import { loadAppRegistry } from '@kelay/contracts/registry';
import { createIdentity, migrateIdentity, socialFromEnv, type IdentityDeps } from './index.ts';

const env = process.env;
const production = env.NODE_ENV === 'production';

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`identity: ${name} is required`);
  return value;
}

const database = new pg.Pool({ connectionString: required('CONTROL_DATABASE_URL') });
const deps: IdentityDeps = {
  database,
  issuer: required('KELAY_ID_ISSUER'),
  secret: production ? required('BETTER_AUTH_SECRET') : (env.BETTER_AUTH_SECRET ?? 'kelay-identity-dev-secret-not-for-production'),
  registry: loadAppRegistry(required('KELAY_APPS_FILE')),
  mcpPublicBaseUrl: required('MCP_PUBLIC_BASE_URL'),
  emailPassword: !production || env.KELAY_ID_EMAIL_PASSWORD === 'true',
  social: socialFromEnv(env),
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
