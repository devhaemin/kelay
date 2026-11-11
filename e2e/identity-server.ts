// Kelay ID for the e2e run: services/identity/src/server.ts with one difference. The real entry
// resolves an MCP client's metadata document over the public internet; this one serves the test
// assistant's document from memory and refuses every other client.
import { serve } from '@hono/node-server';
import pg from 'pg';
import waitOn from 'wait-on';
import { builderSignupFromEnv, controlApiBuilders, controlApiConsents, createReloadingIdentity, migrateIdentity, type IdentityDeps } from '@kelay/identity';
import { registrySourceFromEnv } from '@kelay/contracts/registry';
import { signCallerToken } from '@kelay/tokens';
import { ASSISTANT_CLIENT_ID, ASSISTANT_METADATA } from './assistant.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`e2e identity: ${name} is required`);
  return value;
}

const list = (value: string | undefined) => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const controlApiUrl = required('CONTROL_API_URL');
const callerSecret = required('KELAY_CALLER_SECRET');
const database = new pg.Pool({ connectionString: required('CONTROL_DATABASE_URL') });
const deps: Omit<IdentityDeps, 'registry'> = {
  database,
  issuer: required('KELAY_ID_ISSUER'),
  secret: required('BETTER_AUTH_SECRET'),
  mcpPublicBaseUrl: required('MCP_PUBLIC_BASE_URL'),
  corsOrigins: list(process.env.KELAY_ID_CORS_ORIGINS),
  returnLoopback: true,
  consents: controlApiConsents({ controlApiUrl, callerSecret }),
  builders: { ...builderSignupFromEnv(process.env), requireVerifiedEmail: false, enroll: controlApiBuilders({ controlApiUrl, callerSecret }) },
  fetchClientMetadataResource: async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== ASSISTANT_CLIENT_ID) return new Response('not found', { status: 404 });
    return Response.json(ASSISTANT_METADATA, { headers: { 'cache-control': 'max-age=300' } });
  },
};

await migrateIdentity({ ...deps, registry: { apps: {} } });
// The suite connects an assistant to Ticket Board right away, so the first app list must be the real
// one: a Kelay ID that started before the Control API answers would know no app until its next refresh.
await waitOn({ resources: [`${controlApiUrl.replace(/^http/, 'http-get')}/healthz`], timeout: 60_000, interval: 100 });
const identity = await createReloadingIdentity(deps, {
  source: registrySourceFromEnv(process.env, { callerToken: () => signCallerToken({ kind: 'service', svc: 'identity' }, callerSecret) }),
  refreshMs: Number(process.env.KELAY_APPS_TTL_SECONDS ?? 30) * 1000,
  onError: (error) => console.error(JSON.stringify({ type: 'registry_error', service: 'identity', message: error.message })),
});
const server = serve({ fetch: identity.fetch, port: Number(required('PORT')) }, (info) => {
  console.log(JSON.stringify({ type: 'listening', service: 'identity', port: info.port, issuer: deps.issuer }));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    identity.stop();
    server.close(() => void database.end().finally(() => process.exit(0)));
  });
}
