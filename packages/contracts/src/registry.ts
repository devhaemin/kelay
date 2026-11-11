// Where platform services look up apps (contract §6): a JSON file for local runs and tests, or the
// control API in a deployed environment. Paths in the file are relative to the file itself.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import { AppList, AppRegistry, AppRegistryEntry, AppSchema, AppSlug, CALLER_HEADER, PolicyMatrix, type AppEnvName, type AppSummary } from './index.ts';

const FileEntry = z.object({
  handle: AppSlug,
  databaseUrl: z.string(),
  schema: AppSchema.optional(),
  schemaFile: z.string().optional(),
  policy: PolicyMatrix.optional(),
  policyFile: z.string().optional(),
});
const RegistryFile = z.object({ apps: z.record(AppSlug, FileEntry) });

export function loadAppRegistry(path: string): AppRegistry {
  const base = dirname(resolve(path));
  const raw = RegistryFile.parse(JSON.parse(readFileSync(path, 'utf8')));
  const readJson = (p: string): unknown => JSON.parse(readFileSync(resolve(base, p), 'utf8'));
  const apps: AppRegistry['apps'] = {};
  for (const [slug, e] of Object.entries(raw.apps)) {
    const schema = e.schema ?? (e.schemaFile ? AppSchema.parse(readJson(e.schemaFile)) : undefined);
    if (!schema) throw new Error(`registry: app ${slug} has neither schema nor schemaFile`);
    if (schema.app !== slug) throw new Error(`registry: app ${slug} schema declares app ${schema.app}`);
    const policy = e.policy ?? (e.policyFile ? PolicyMatrix.parse(readJson(e.policyFile)) : undefined);
    apps[slug] = { handle: e.handle, databaseUrl: e.databaseUrl, schema, ...(policy ? { policy } : {}) };
  }
  return AppRegistry.parse({ apps });
}

export interface AppRegistrySource {
  readonly kind: 'file' | 'control-api';
  /** The app as deployed in `env` (default prod); undefined when there is no such app or deployment. */
  get(app: string, env?: AppEnvName): Promise<AppRegistryEntry | undefined>;
  list(env?: AppEnvName): Promise<AppSummary[]>;
}

/** A fixed registry. It has one entry per app, so it answers the same for dev and prod. */
export function staticRegistrySource(registry: AppRegistry): AppRegistrySource {
  const list = Object.entries(registry.apps).map(([app, entry]) => ({ app, handle: entry.handle }));
  return {
    kind: 'file',
    get: async (app) => (Object.hasOwn(registry.apps, app) ? registry.apps[app] : undefined),
    list: async () => list,
  };
}

export interface ControlApiRegistryOptions {
  /** CONTROL_API_URL. */
  controlApiUrl: string;
  /** A `service` caller token (contract §4) for each request, e.g. `() => signCallerToken({ kind: 'service', svc }, secret)`. */
  callerToken: () => Promise<string>;
  /** How long an answer is reused, "no such app" included. @default 30000 */
  ttlMs?: number;
  /** Apps kept in memory. @default 2000 */
  maxApps?: number;
  /** @default 5000 */
  timeoutMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export class RegistryUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RegistryUnavailableError';
  }
}

/**
 * Reads apps from the control API (`GET /internal/v1/apps[/:app]?env=`). Answers are cached for
 * `ttlMs`; when the control API cannot be reached, the last answer keeps being served, so a control
 * API restart does not take the data path down with it.
 */
export function controlApiRegistrySource(opts: ControlApiRegistryOptions): AppRegistrySource {
  const base = opts.controlApiUrl.replace(/\/+$/, '');
  const send = opts.fetch ?? ((url, init) => fetch(url, init));
  const ttl = opts.ttlMs ?? 30_000;

  async function request(path: string, signal: AbortSignal): Promise<Response> {
    try {
      return await send(`${base}${path}`, {
        headers: { accept: 'application/json', [CALLER_HEADER]: await opts.callerToken() },
        signal: AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? 5000)]),
      });
    } catch (e) {
      throw new RegistryUnavailableError(`registry: the control API did not answer GET ${path}: ${(e as Error).message}`, { cause: e });
    }
  }
  const refused = (path: string, res: Response) => new RegistryUnavailableError(`registry: the control API answered ${res.status} to GET ${path}`);

  // lru-cache stores no undefined, so "no such app" is cached as an object without an entry.
  const cached = { ttl, noDeleteOnFetchRejection: true } as const;
  // A failed refresh leaves the expired answer in the cache; without one, the failure is the answer.
  async function lookup<K extends {}, V extends {}>(cache: LRUCache<K, V>, key: K): Promise<V | undefined> {
    try {
      return await cache.fetch(key);
    } catch (e) {
      const last = cache.get(key, { allowStale: true, noDeleteOnStaleGet: true });
      if (last === undefined) throw e;
      return last;
    }
  }
  const entries = new LRUCache<string, { entry?: AppRegistryEntry }>({
    ...cached,
    max: opts.maxApps ?? 2000,
    async fetchMethod(key, _stale, { signal }) {
      const [env, app] = key.split(':') as [AppEnvName, string];
      const path = `/internal/v1/apps/${encodeURIComponent(app)}?env=${env}`;
      const res = await request(path, signal);
      if (res.status === 404) return {};
      if (!res.ok) throw refused(path, res);
      return { entry: AppRegistryEntry.parse(await res.json()) };
    },
  });
  const lists = new LRUCache<AppEnvName, AppSummary[]>({
    ...cached,
    max: 2,
    async fetchMethod(env, _stale, { signal }) {
      const path = `/internal/v1/apps?env=${env}`;
      const res = await request(path, signal);
      if (!res.ok) throw refused(path, res);
      return AppList.parse(await res.json()).apps;
    },
  });

  return {
    kind: 'control-api',
    async get(app, env = 'prod') {
      // Anything that is not a slug cannot be an app, and must not reach the URL or the cache key.
      if (!AppSlug.safeParse(app).success) return undefined;
      return (await lookup(entries, `${env}:${app}`))?.entry;
    },
    async list(env = 'prod') {
      return (await lookup(lists, env)) ?? [];
    },
  };
}

export interface RegistryEnvOptions {
  /** Signs the `service` caller token for control API mode. */
  callerToken: () => Promise<string>;
  /** Turns a relative KELAY_APPS_FILE into the path to read. */
  resolvePath?: (path: string) => string;
}

/**
 * The registry a service process uses, from its environment: `KELAY_APPS_SOURCE=file` (the default)
 * reads `KELAY_APPS_FILE`; `control-api` asks `CONTROL_API_URL`, caching for `KELAY_APPS_TTL_SECONDS`.
 */
export function registrySourceFromEnv(env: Record<string, string | undefined>, opts: RegistryEnvOptions): AppRegistrySource {
  const mode = env.KELAY_APPS_SOURCE || 'file';
  if (mode === 'file') {
    const path = env.KELAY_APPS_FILE;
    if (!path) throw new Error('registry: KELAY_APPS_FILE is required when KELAY_APPS_SOURCE is file');
    return staticRegistrySource(loadAppRegistry(opts.resolvePath?.(path) ?? path));
  }
  if (mode === 'control-api') {
    const controlApiUrl = env.CONTROL_API_URL;
    if (!controlApiUrl) throw new Error('registry: CONTROL_API_URL is required when KELAY_APPS_SOURCE is control-api');
    const ttlSeconds = env.KELAY_APPS_TTL_SECONDS ? Number(env.KELAY_APPS_TTL_SECONDS) : undefined;
    if (ttlSeconds !== undefined && !(ttlSeconds > 0)) throw new Error('registry: KELAY_APPS_TTL_SECONDS must be a positive number');
    return controlApiRegistrySource({ controlApiUrl, callerToken: opts.callerToken, ...(ttlSeconds ? { ttlMs: ttlSeconds * 1000 } : {}) });
  }
  throw new Error(`registry: KELAY_APPS_SOURCE must be file or control-api, got "${mode}"`);
}
