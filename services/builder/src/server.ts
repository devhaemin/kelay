// Builder process entry: reads env, serves on PORT (default 4006) and runs the improvement worker.
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { LOCAL_PORTS } from '@kelay/contracts';
import { remoteJwks } from '@kelay/tokens';
import { DEFAULT_BUILDER_MODEL } from './agents/claude.ts';
import { selectAgent } from './agents/select.ts';
import { artifactStoreFromEnv } from './artifacts/store.ts';
import { createBuilderApi } from './app.ts';
import { ControlClient } from './control.ts';
import { FargateWorkspaceDriver } from './drivers/fargate.ts';
import { LocalWorkspaceDriver } from './drivers/local.ts';
import type { WorkspaceDriver } from './drivers/types.ts';
import type { AgentInfo } from './events.ts';
import { ImprovementWorker } from './improvements.ts';
import { createLogger } from './log.ts';
import { PgDatabaseProvisioner } from './provision.ts';
import { WorkspaceManager } from './workspaces.ts';

const log = createLogger();
const env = process.env;
const REPO = fileURLToPath(new URL('../../..', import.meta.url));

function need(name: string): string {
  const v = env[name];
  if (!v) {
    log.fatal({ type: 'config', missing: name }, `${name} is required`);
    process.exit(1);
  }
  return v;
}

const list = (name: string) => need(name).split(',').map((s) => s.trim()).filter(Boolean);
const home = resolve(env.BUILDER_HOME ?? resolve(REPO, '.kelay'));

let driver: WorkspaceDriver;
let agent: AgentInfo;
try {
  if (env.BUILDER_WORKSPACE_DRIVER === 'fargate') {
    // The agent runs inside the task and reaches the model through the LLM gateway with the gateway's key.
    const workspaceKey = env.BUILDER_WORKSPACE_API_KEY;
    agent = workspaceKey && env.BUILDER_AGENT !== 'scripted' ? { kind: 'claude', model: env.BUILDER_MODEL ?? DEFAULT_BUILDER_MODEL } : { kind: 'scripted', model: null };
    driver = new FargateWorkspaceDriver({
      cluster: need('BUILDER_ECS_CLUSTER'),
      fileSystemId: need('BUILDER_EFS_FILE_SYSTEM_ID'),
      subnets: list('BUILDER_SUBNETS'),
      securityGroups: list('BUILDER_SECURITY_GROUPS'),
      image: need('BUILDER_WORKSPACE_IMAGE'),
      executionRoleArn: need('BUILDER_EXECUTION_ROLE_ARN'),
      taskRoleArn: need('BUILDER_TASK_ROLE_ARN'),
      previewUrlTemplate: need('BUILDER_PREVIEW_URL_TEMPLATE'),
      environment: {
        BUILDER_AGENT: agent.kind,
        ...(agent.model ? { BUILDER_MODEL: agent.model } : {}),
        ...(workspaceKey ? { ANTHROPIC_API_KEY: workspaceKey, ANTHROPIC_BASE_URL: need('ANTHROPIC_BASE_URL') } : {}),
      },
    });
  } else {
    const coder = selectAgent(env, resolve(home, 'agent-home'));
    agent = coder.info;
    driver = new LocalWorkspaceDriver({
      root: resolve(env.KELAY_WORKSPACES_ROOT ?? resolve(home, 'workspaces')),
      templateDir: resolve(env.KELAY_TEMPLATE_DIR ?? resolve(REPO, 'templates/starter')),
      agent: coder,
    });
  }
} catch (e) {
  log.fatal({ type: 'config', err: (e as Error).message }, (e as Error).message);
  process.exit(1);
}

let artifacts: ReturnType<typeof artifactStoreFromEnv>;
try {
  artifacts = artifactStoreFromEnv(env, resolve(home, 'artifacts'));
} catch (e) {
  log.fatal({ type: 'config', err: (e as Error).message }, (e as Error).message);
  process.exit(1);
}

const control = new ControlClient({ baseUrl: need('CONTROL_API_URL'), callerSecret: need('KELAY_CALLER_SECRET') });
const workspaces = new WorkspaceManager({
  driver,
  control,
  agent,
  stateDir: resolve(home, 'state'),
  logger: log,
  ...(artifacts ? { artifacts } : {}),
  runtimeEnv: Object.fromEntries(['DATA_API_URL', 'CONTROL_API_URL'].filter((k) => env[k]).map((k) => [k, env[k]!])),
  ...(env.APP_DATABASE_URL_TEMPLATE ? { provisioner: new PgDatabaseProvisioner(env.APP_DATABASE_URL_TEMPLATE) } : {}),
  ...(env.BUILDER_IDLE_MINUTES ? { idleMs: Number(env.BUILDER_IDLE_MINUTES) * 60_000 } : {}),
});

const app = createBuilderApi({
  auth: { issuer: need('KELAY_ID_ISSUER'), jwks: remoteJwks(need('KELAY_ID_JWKS_URL')) },
  control,
  workspaces,
  logger: log,
});

const worker = new ImprovementWorker({
  control,
  workspaces,
  logger: log,
  worker: `builder@${hostname()}`,
  ...(env.BUILDER_IMPROVEMENT_POLL_MS ? { pollMs: Number(env.BUILDER_IMPROVEMENT_POLL_MS) } : {}),
});
if (env.BUILDER_IMPROVEMENTS !== 'off') worker.start();

const port = Number(env.PORT ?? LOCAL_PORTS.builder);
const server = serve({ fetch: app.fetch, port }, (info) => {
  log.info({ type: 'listen', port: info.port, driver: driver.name, agent, artifacts: artifacts?.name ?? 'off' }, `builder listening; coding agent: ${agent.kind}${agent.model ? ` (${agent.model})` : ''}`);
});

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  log.info({ type: 'shutdown', signal }, 'shutting down');
  void worker.stop();
  // Open event streams would keep the server from closing.
  server.close();
  void workspaces.shutdown().finally(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
