import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { LOCAL_PORTS } from '@kelay/contracts';
import { loadAppRegistry } from '@kelay/contracts/registry';
import { remoteJwks } from '@kelay/tokens';
import { z } from 'zod';
import { authorizationServerMetadataUrl, createGateway } from './index.ts';

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(LOCAL_PORTS.mcpGateway),
  MCP_PUBLIC_BASE_URL: z.url(),
  KELAY_ID_ISSUER: z.url(),
  KELAY_ID_JWKS_URL: z.url(),
  KELAY_CALLER_SECRET: z.string().min(32),
  KELAY_APPS_FILE: z.string().min(1),
  DATA_API_URL: z.url(),
  MCP_RATE_PER_MIN: z.coerce.number().int().positive().default(60),
});
const env = Env.parse(process.env);

// `pnpm --filter <svc> dev` runs from the repo root, where .env's relative KELAY_APPS_FILE points;
// pnpm reports that directory as INIT_CWD while the script itself runs in the package directory.
const registry = loadAppRegistry(resolve(process.env.INIT_CWD ?? process.cwd(), env.KELAY_APPS_FILE));

// Kelay ID is better-auth, which serves its OAuth endpoints under the same base path as its JWKS.
const authBase = env.KELAY_ID_JWKS_URL.replace(/\/jwks\/?$/, '');

const app = createGateway({
  config: {
    publicBaseUrl: env.MCP_PUBLIC_BASE_URL,
    issuer: env.KELAY_ID_ISSUER,
    dataApiUrl: env.DATA_API_URL,
    callerSecret: env.KELAY_CALLER_SECRET,
    ratePerMin: env.MCP_RATE_PER_MIN,
    oauth: {
      authorizationUrl: `${authBase}/oauth2/authorize`,
      tokenUrl: `${authBase}/oauth2/token`,
      metadataUrl: authorizationServerMetadataUrl(env.KELAY_ID_ISSUER),
    },
  },
  registry,
  jwks: remoteJwks(env.KELAY_ID_JWKS_URL),
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(JSON.stringify({ type: 'listening', service: 'mcp-gateway', port: info.port, apps: Object.keys(registry.apps) }));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
