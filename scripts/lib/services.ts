// Starts the platform services as child processes and waits until each one answers.
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import type { Writable } from 'node:stream';
import concurrently from 'concurrently';
import waitOn from 'wait-on';
import { ROOT, portOf, serviceEnv, type StackConfig } from './config.ts';

export interface StartOptions {
  /** Restart services when their source changes (`tsx watch`), as each service's `dev` script does. */
  watch: boolean;
  /** Also start the console (CONSOLE_DATA=http) and the dev sign-in helper. */
  console: boolean;
  /** Also start the Builder (services/builder) with local workspaces. `env` is added to its environment. */
  builder?: boolean | { env: Record<string, string> };
  /** Kelay ID entry file, relative to the repo root. The e2e suite swaps in one that can resolve its test assistant. */
  identityEntry?: string;
  /** Where the services' log lines go. Defaults to this process's stdout. */
  output?: Writable;
}

export interface RunningStack {
  /** Settles when the processes have exited; rejects when one of them fails. */
  done: Promise<unknown>;
  stop(): Promise<void>;
}

interface Service {
  name: string;
  dir: string;
  entry: string;
  port: number;
  health: string;
  color: string;
  env?: Record<string, string>;
  /** Never restarted on a source change: it owns child processes (the dev previews) and running turns. */
  noWatch?: boolean;
}

function services(cfg: StackConfig, opts: StartOptions): Service[] {
  const list: Service[] = [
    { name: 'identity', dir: 'services/identity', entry: opts.identityEntry ? resolve(ROOT, opts.identityEntry) : 'src/server.ts', port: portOf(cfg.issuer), health: `${cfg.issuer}/healthz`, color: 'magenta' },
    { name: 'data-api', dir: 'services/data-api', entry: 'src/server.ts', port: portOf(cfg.dataApiUrl), health: `${cfg.dataApiUrl}/healthz`, color: 'green' },
    { name: 'control-api', dir: 'services/control-api', entry: 'src/server.ts', port: portOf(cfg.controlApiUrl), health: `${cfg.controlApiUrl}/healthz`, color: 'blue' },
    { name: 'runner', dir: 'services/runner', entry: 'src/server.ts', port: portOf(cfg.runnerUrl), health: `${cfg.runnerUrl}/healthz`, color: 'red' },
    { name: 'mcp-gateway', dir: 'services/mcp-gateway', entry: 'src/server.ts', port: portOf(cfg.mcpPublicBaseUrl), health: `${cfg.mcpPublicBaseUrl}/healthz`, color: 'yellow' },
  ];
  if (opts.builder) {
    // The coding agent is Claude when ANTHROPIC_API_KEY is set (directly, or the LLM gateway's key with
    // ANTHROPIC_BASE_URL), and the scripted Ticket Board demo otherwise. BUILDER_AGENT overrides that.
    const agentEnv = Object.fromEntries(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'BUILDER_AGENT', 'BUILDER_MODEL', 'BUILDER_HOME'].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
    list.push({
      name: 'builder',
      dir: 'services/builder',
      entry: 'src/server.ts',
      port: portOf(cfg.builderUrl),
      health: `${cfg.builderUrl}/healthz`,
      color: 'red',
      env: { ...agentEnv, APP_DATABASE_URL_TEMPLATE: cfg.appDatabaseUrlTemplate, ...(opts.builder === true ? {} : opts.builder.env) },
      noWatch: true,
    });
  }
  if (opts.console) {
    list.push(
      { name: 'console', dir: 'apps/console', entry: '', port: portOf(cfg.consoleUrl), health: `${cfg.consoleUrl}/signin`, color: 'cyan', env: { CONSOLE_DATA: 'http' } },
      { name: 'dev-login', dir: '.', entry: 'scripts/dev-login.ts --serve', port: portOf(cfg.devLoginUrl), health: `${cfg.devLoginUrl}/healthz`, color: 'gray' },
    );
  }
  return list;
}

const listening = (port: number) =>
  new Promise<boolean>((done) => {
    const socket = createConnection({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });

export async function startStack(cfg: StackConfig, opts: StartOptions): Promise<RunningStack> {
  const list = services(cfg, opts);
  for (const s of list) {
    if (await listening(s.port)) throw new Error(`port ${s.port} (${s.name}) is already in use; stop what is listening there or change the URL in .env`);
  }
  const shared = serviceEnv(cfg);
  const { commands, result } = concurrently(
    list.map((s) => ({
      name: s.name,
      // The console is a Next.js app with its own dev server; everything else is a tsx entry file.
      command: s.name === 'console' ? 'pnpm exec next dev' : `pnpm exec tsx ${opts.watch && !s.noWatch ? 'watch ' : ''}${s.entry}`,
      cwd: resolve(ROOT, s.dir),
      env: { ...shared, ...s.env, PORT: String(s.port) },
      ...(opts.output ? {} : { prefixColor: s.color }),
    })),
    { prefix: 'name', killOthersOn: ['failure', 'success'], ...(opts.output ? { outputStream: opts.output, prefixColors: false as const } : {}) },
  );
  const done = result.then(
    () => undefined,
    (events: unknown) => {
      const failed = Array.isArray(events) ? events.filter((e) => e.exitCode !== 0 && !e.killed).map((e) => e.command.name) : [];
      if (failed.length) throw new Error(`${failed.join(', ')} exited with an error`);
    },
  );
  const stop = async () => {
    for (const c of commands) c.kill('SIGTERM');
    await done.catch(() => {});
  };
  try {
    await Promise.race([
      waitOn({ resources: list.map((s) => s.health.replace(/^http/, 'http-get')), timeout: 120_000, interval: 250, validateStatus: (status: number) => status < 500 }),
      done.then(() => {
        throw new Error('a service exited while the stack was starting');
      }),
    ]);
  } catch (e) {
    await stop();
    throw e;
  }
  return { done, stop };
}
