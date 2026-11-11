import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { LOCAL_PORTS } from '@kelay/contracts';
import { loadAppRegistry } from '@kelay/contracts/registry';
import { remoteJwks } from '@kelay/tokens';
import { z } from 'zod';
import { createControlApiMeter, createGateway, stdoutMeter, teeMeter } from './index.ts';

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(LOCAL_PORTS.mcpGateway),
  MCP_PUBLIC_BASE_URL: z.url(),
  KELAY_ID_ISSUER: z.url(),
  KELAY_ID_JWKS_URL: z.url(),
  KELAY_CALLER_SECRET: z.string().min(32),
  KELAY_APPS_FILE: z.string().min(1),
  DATA_API_URL: z.url(),
  MCP_RATE_PER_MIN: z.coerce.number().int().positive().default(60),
  CONTROL_API_URL: z.url().optional(),
});
const env = Env.parse(process.env);

// `pnpm --filter <svc> dev` runs from the repo root, where .env's relative KELAY_APPS_FILE points;
// pnpm reports that directory as INIT_CWD while the script itself runs in the package directory.
const registry = loadAppRegistry(resolve(process.env.INIT_CWD ?? process.cwd(), env.KELAY_APPS_FILE));

// Call records always go to stdout; with CONTROL_API_URL they also reach the control API, which feeds Monitoring.
const controlMeter = env.CONTROL_API_URL
  ? createControlApiMeter({
      controlApiUrl: env.CONTROL_API_URL,
      callerSecret: env.KELAY_CALLER_SECRET,
      onError: (error) => console.error(JSON.stringify({ type: 'meter_error', message: error.message })),
    })
  : undefined;

const app = createGateway({
  config: {
    publicBaseUrl: env.MCP_PUBLIC_BASE_URL,
    issuer: env.KELAY_ID_ISSUER,
    dataApiUrl: env.DATA_API_URL,
    callerSecret: env.KELAY_CALLER_SECRET,
    ratePerMin: env.MCP_RATE_PER_MIN,
  },
  registry,
  jwks: remoteJwks(env.KELAY_ID_JWKS_URL),
  ...(controlMeter ? { meter: teeMeter(stdoutMeter, controlMeter.sink) } : {}),
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(JSON.stringify({ type: 'listening', service: 'mcp-gateway', port: info.port, apps: Object.keys(registry.apps) }));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => void (controlMeter?.flush() ?? Promise.resolve()).finally(() => process.exit(0))));
}
