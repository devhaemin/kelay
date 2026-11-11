import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { AppSlug, GraphSpec, LOCAL_PORTS } from '@kelay/contracts';
import { remoteJwks } from '@kelay/tokens';
import { z } from 'zod';
import { LocalRunDriver, SfnRunDriver, createControlApiRecorder, createRunner, stdoutRecorder, teeRecorder, type LocalNodes, type RunDriver } from './index.ts';

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(LOCAL_PORTS.runner),
  KELAY_ID_ISSUER: z.url(),
  KELAY_ID_JWKS_URL: z.url(),
  KELAY_CALLER_SECRET: z.string().min(32),
  CONTROL_API_URL: z.url().optional(),
  RUNNER_DRIVER: z.enum(['local', 'sfn']).default('local'),
  RUNNER_MAX_CONCURRENT_RUNS_PER_USER: z.coerce.number().int().positive().default(2),
  /** local driver: comma-separated `<app>=<module>`; each module exports `nodes` (see LocalNodes). */
  RUNNER_LOCAL_NODES: z.string().optional(),
  /** sfn driver: `arn:aws:states:<region>:<account>:stateMachine:`. */
  KELAY_STATE_MACHINE_ARN_PREFIX: z.string().regex(/^arn:aws[a-z-]*:states:[a-z0-9-]+:\d{12}:stateMachine:$/).optional(),
  AWS_REGION: z.string().optional(),
});
const env = Env.parse(process.env);

const LocalModule = z.object({
  nodes: z.object({ graphs: z.array(GraphSpec), invoke: z.custom<LocalNodes['invoke']>((v) => typeof v === 'function', 'must be a function') }),
});

/** A path is resolved like KELAY_APPS_FILE: against the directory `pnpm --filter … dev` was started from. */
async function loadLocalNodes(list: string): Promise<Record<string, LocalNodes>> {
  const apps: Record<string, LocalNodes> = {};
  for (const item of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = item.indexOf('=');
    const app = AppSlug.parse(item.slice(0, at));
    const target = item.slice(at + 1);
    const isPath = target.startsWith('.') || isAbsolute(target);
    const specifier = isPath ? pathToFileURL(resolve(process.env.INIT_CWD ?? process.cwd(), target)).href : target;
    const loaded = LocalModule.safeParse(await import(specifier));
    if (!loaded.success) throw new Error(`RUNNER_LOCAL_NODES: ${target} must export \`nodes\` ({ graphs, invoke }): ${z.prettifyError(loaded.error)}`);
    apps[app] = loaded.data.nodes;
  }
  return apps;
}

let driver: RunDriver;
let graphs: Record<string, string[]> | undefined;
if (env.RUNNER_DRIVER === 'sfn') {
  if (!env.KELAY_STATE_MACHINE_ARN_PREFIX) throw new Error('runner: KELAY_STATE_MACHINE_ARN_PREFIX is required with RUNNER_DRIVER=sfn');
  driver = new SfnRunDriver({ stateMachineArnPrefix: env.KELAY_STATE_MACHINE_ARN_PREFIX, ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}) });
} else {
  const apps = await loadLocalNodes(env.RUNNER_LOCAL_NODES ?? '');
  graphs = Object.fromEntries(Object.entries(apps).map(([app, nodes]) => [app, nodes.graphs.map((g) => g.name)]));
  driver = new LocalRunDriver({ apps, callerSecret: env.KELAY_CALLER_SECRET });
}

const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

const app = createRunner({
  driver,
  jwks: remoteJwks(env.KELAY_ID_JWKS_URL),
  issuer: env.KELAY_ID_ISSUER,
  callerSecret: env.KELAY_CALLER_SECRET,
  maxConcurrentPerUser: env.RUNNER_MAX_CONCURRENT_RUNS_PER_USER,
  record: env.CONTROL_API_URL
    ? teeRecorder(stdoutRecorder, createControlApiRecorder({ controlApiUrl: env.CONTROL_API_URL, callerSecret: env.KELAY_CALLER_SECRET }))
    : stdoutRecorder,
  onError: (error) => console.error(JSON.stringify({ type: 'error', service: 'runner', message: error.message })),
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log({ type: 'listening', service: 'runner', port: info.port, driver: driver.name, ...(graphs ? { graphs } : {}) });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
