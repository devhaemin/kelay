import { serve } from '@hono/node-server';
import { LOCAL_PORTS } from '@kelay/contracts';
import { remoteJwks } from '@kelay/tokens';
import { createControlApi } from './app.ts';
import { createAppDatabases } from './appdb.ts';
import { createDatabase } from './db/client.ts';
import { AwsDeployDriver } from './deploy/aws.ts';
import { LocalDeployDriver, type DeployDriver } from './deploy/driver.ts';
import { AnthropicLlm } from './llm/anthropic.ts';
import { createLogger } from './log.ts';
import { PgImprovementQueue, SqsImprovementQueue, type ImprovementQueue } from './queue/improvement.ts';

const log = createLogger();

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    log.fatal({ type: 'config', missing: name }, `${name} is required`);
    process.exit(1);
  }
  return v;
}

const env = process.env;
const database = createDatabase(need('CONTROL_DATABASE_URL'));

const effort = (v: string | undefined) => (v as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined) || undefined;
const llm = new AnthropicLlm({
  baseURL: need('LLM_GATEWAY_URL'),
  apiKey: need('LLM_GATEWAY_KEY'),
  ...(env.LLM_MODEL ? { model: env.LLM_MODEL } : {}),
  ...(env.LLM_TRIAGE_MODEL ? { triageModel: env.LLM_TRIAGE_MODEL } : {}),
  ...(env.LLM_REPORT_MODEL ? { reportModel: env.LLM_REPORT_MODEL } : {}),
  ...(effort(env.LLM_TRIAGE_EFFORT) ? { triageEffort: effort(env.LLM_TRIAGE_EFFORT)! } : {}),
  ...(effort(env.LLM_REPORT_EFFORT) ? { reportEffort: effort(env.LLM_REPORT_EFFORT)! } : {}),
  fallbacks: env.LLM_FALLBACKS !== 'off',
});

const deploy: DeployDriver =
  env.KELAY_DEPLOY_DRIVER === 'aws'
    ? new AwsDeployDriver({
        lambdaRoleArn: need('KELAY_LAMBDA_ROLE_ARN'),
        stepFunctionsRoleArn: need('KELAY_SFN_ROLE_ARN'),
        ...(env.KELAY_ROUTER_PRINCIPAL ? { routerPrincipal: env.KELAY_ROUTER_PRINCIPAL } : {}),
        ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
        runtimeEnv: Object.fromEntries(
          ['KELAY_ID_ISSUER', 'DATA_API_URL', 'CONTROL_API_URL', 'MCP_PUBLIC_BASE_URL', 'LLM_GATEWAY_URL']
            .filter((k) => env[k])
            .map((k) => [k, env[k]!]),
        ),
      })
    : new LocalDeployDriver();

const improvements: ImprovementQueue = env.IMPROVEMENT_QUEUE_URL
  ? new SqsImprovementQueue({ queueUrl: env.IMPROVEMENT_QUEUE_URL })
  : new PgImprovementQueue(database.db);

const appDbs = createAppDatabases({ onPoolError: (err) => log.error({ type: 'app_db', err: err.message }, 'app database connection failed') });

const app = createControlApi({
  db: database.db,
  appDbs,
  auth: { issuer: need('KELAY_ID_ISSUER'), jwks: remoteJwks(need('KELAY_ID_JWKS_URL')), callerSecret: need('KELAY_CALLER_SECRET') },
  llm,
  deploy,
  improvements,
  logger: log,
  ...(env.APP_DATABASE_URL_TEMPLATE ? { databaseUrlTemplate: env.APP_DATABASE_URL_TEMPLATE } : {}),
  ...(env.FEEDBACK_DEDUPE_THRESHOLD ? { dedupeThreshold: Number(env.FEEDBACK_DEDUPE_THRESHOLD) } : {}),
  ...(env.CALLER_TOKEN_TTL_SECONDS ? { callerTokenTtlSeconds: Number(env.CALLER_TOKEN_TTL_SECONDS) } : {}),
});

const port = Number(env.PORT ?? LOCAL_PORTS.controlApi);
const server = serve({ fetch: app.fetch, port }, (info) => {
  log.info({ type: 'listen', port: info.port, deployDriver: deploy.name, improvementQueue: improvements.kind }, 'control-api listening');
});

const shutdown = (signal: string) => {
  log.info({ type: 'shutdown', signal }, 'shutting down');
  server.close(() => void Promise.allSettled([database.close(), appDbs.close()]).finally(() => process.exit(0)));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
