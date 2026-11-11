import { serve } from '@hono/node-server';
import { LOCAL_PORTS } from '@kelay/contracts';
import { registrySourceFromEnv } from '@kelay/contracts/registry';
import { remoteJwks, signCallerToken } from '@kelay/tokens';
import { createApp, createLogger } from './app.ts';
import { createDatabases } from './db.ts';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`data-api: ${name} is required`);
  return value;
}

const logger = createLogger();
const callerSecret = env('KELAY_CALLER_SECRET');
if (callerSecret.length < 32) throw new Error('data-api: KELAY_CALLER_SECRET must be at least 32 characters');
const port = Number(process.env.PORT ?? LOCAL_PORTS.dataApi);

const registry = registrySourceFromEnv(process.env, { callerToken: () => signCallerToken({ kind: 'service', svc: 'data-api' }, callerSecret) });
const databases = createDatabases({
  ...(process.env.DATA_API_POOL_MAX ? { poolMax: Number(process.env.DATA_API_POOL_MAX) } : {}),
  onPoolError: (err) => logger.error({ type: 'pool_error', err }, 'idle client error'),
});
const app = createApp({
  jwks: remoteJwks(env('KELAY_ID_JWKS_URL')),
  issuer: env('KELAY_ID_ISSUER'),
  callerSecret,
  registry,
  databases,
  logger,
});

const server = serve({ fetch: app.fetch, port }, (info) => logger.info({ type: 'listening', port: info.port, apps: registry.kind }, 'data-api listening'));

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ type: 'shutdown', signal }, 'data-api stopping');
  server.close(() => {
    databases.close().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
