// Kelay ID for the e2e run: services/identity/src/server.ts with one difference. The real entry
// resolves an MCP client's metadata document over the public internet; this one serves the test
// assistant's document from memory and refuses every other client.
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createIdentity, migrateIdentity, type IdentityDeps } from '@kelay/identity';
import { loadAppRegistry } from '@kelay/contracts/registry';
import { ASSISTANT_CLIENT_ID, ASSISTANT_METADATA } from './assistant.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`e2e identity: ${name} is required`);
  return value;
}

const database = new pg.Pool({ connectionString: required('CONTROL_DATABASE_URL') });
const deps: IdentityDeps = {
  database,
  issuer: required('KELAY_ID_ISSUER'),
  secret: required('BETTER_AUTH_SECRET'),
  registry: loadAppRegistry(required('KELAY_APPS_FILE')),
  mcpPublicBaseUrl: required('MCP_PUBLIC_BASE_URL'),
  fetchClientMetadataResource: async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== ASSISTANT_CLIENT_ID) return new Response('not found', { status: 404 });
    return Response.json(ASSISTANT_METADATA, { headers: { 'cache-control': 'max-age=300' } });
  },
};

await migrateIdentity(deps);
const identity = createIdentity(deps);
const server = serve({ fetch: identity.app.fetch, port: Number(required('PORT')) }, (info) => {
  console.log(JSON.stringify({ type: 'listening', service: 'identity', port: info.port, issuer: identity.issuer }));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => void database.end().finally(() => process.exit(0)));
  });
}
