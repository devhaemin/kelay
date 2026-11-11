// The Router Worker's route table, written from here: after every deploy and publish the app's entry
// names the function URL of each env it is deployed to (docs/infrastructure.md §1 "Edge"). The Router
// reads it from Workers KV under `app:<handle>/<app>` (AppRoute in @kelay/contracts).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppRoute, routeKey, type AppRouteTarget } from '@kelay/contracts';
import type { Executor } from '../db/client.ts';
import type { DeployResources, EnvName } from '../db/schema.ts';
import { ENV_NAMES } from '../db/schema.ts';
import { loadEnv } from '../routes/util.ts';

export interface RouteStore {
  readonly name: 'memory' | 'file' | 'cloudflare-kv';
  /** Writes the app's entry, replacing the one that is there. */
  put(handle: string, app: string, route: AppRoute): Promise<void>;
  /** Takes the app off the Router. Deleting an entry that is not there is not an error. */
  delete(handle: string, app: string): Promise<void>;
}

/** For tests and local runs, where no Router reads the table. */
export class MemoryRouteStore implements RouteStore {
  readonly name = 'memory';
  readonly routes = new Map<string, AppRoute>();

  async put(handle: string, app: string, route: AppRoute): Promise<void> {
    this.routes.set(routeKey(handle, app), AppRoute.parse(route));
  }

  async delete(handle: string, app: string): Promise<void> {
    this.routes.delete(routeKey(handle, app));
  }
}

/** One JSON file, `{ "app:<handle>/<app>": AppRoute }`: a table to look at, or to load into a local Router. */
export class FileRouteStore implements RouteStore {
  readonly name = 'file';
  private readonly file: string;
  /** Writes are whole-file, so they run one after another. */
  private queue: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = resolve(file);
  }

  private change(apply: (table: Record<string, AppRoute>) => void): Promise<void> {
    const done = this.queue.then(() => {
      const table = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, AppRoute>) : {};
      apply(table);
      mkdirSync(dirname(this.file), { recursive: true });
      // Written beside the file and moved over it, so a reader never sees half a table.
      writeFileSync(`${this.file}.tmp`, `${JSON.stringify(table, null, 2)}\n`);
      renameSync(`${this.file}.tmp`, this.file);
    });
    this.queue = done.catch(() => undefined);
    return done;
  }

  async put(handle: string, app: string, route: AppRoute): Promise<void> {
    const parsed = AppRoute.parse(route);
    await this.change((table) => void (table[routeKey(handle, app)] = parsed));
  }

  delete(handle: string, app: string): Promise<void> {
    return this.change((table) => void delete table[routeKey(handle, app)]);
  }
}

export interface CloudflareKvOptions {
  accountId: string;
  /** The ROUTES namespace of the Router Worker (`routes_kv_namespace_id` in the Terraform outputs). */
  namespaceId: string;
  /** An API token with Workers KV Storage: Edit, and nothing else. */
  apiToken: string;
  /** @default https://api.cloudflare.com/client/v4 */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Workers KV through the Cloudflare API: one request per entry. */
export class CloudflareKvRouteStore implements RouteStore {
  readonly name = 'cloudflare-kv';
  private readonly fetch_: typeof fetch;

  constructor(private readonly opts: CloudflareKvOptions) {
    for (const [name, value, shape] of [['account id', opts.accountId, /^[0-9a-f]{32}$/], ['KV namespace id', opts.namespaceId, /^[0-9a-f]{32}$/]] as const) {
      if (!shape.test(value)) throw new Error(`the Cloudflare ${name} must be 32 hexadecimal characters`);
    }
    if (!opts.apiToken) throw new Error('the Cloudflare API token is empty');
    this.fetch_ = opts.fetch ?? fetch;
  }

  private async call(method: 'PUT' | 'DELETE', handle: string, app: string, body?: string): Promise<void> {
    const key = routeKey(handle, app);
    const url = `${(this.opts.baseUrl ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '')}/accounts/${this.opts.accountId}/storage/kv/namespaces/${this.opts.namespaceId}/values/${encodeURIComponent(key)}`;
    let res: Response;
    try {
      res = await this.fetch_(url, {
        method,
        headers: { authorization: `Bearer ${this.opts.apiToken}`, ...(body === undefined ? {} : { 'content-type': 'text/plain' }) },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (e) {
      throw new Error(`Cloudflare KV could not be reached for ${key}: ${(e as Error).message}`);
    }
    if (res.ok || (method === 'DELETE' && res.status === 404)) {
      await res.body?.cancel();
      return;
    }
    const answer = (await res.json().catch(() => null)) as { errors?: { code?: number; message?: string }[] } | null;
    const reason = answer?.errors?.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare KV refused ${method} ${key}: ${reason}`);
  }

  async put(handle: string, app: string, route: AppRoute): Promise<void> {
    await this.call('PUT', handle, app, JSON.stringify(AppRoute.parse(route)));
  }

  delete(handle: string, app: string): Promise<void> {
    return this.call('DELETE', handle, app);
  }
}

export interface RouteStoreEnv {
  ROUTE_STORE?: string | undefined;
  ROUTES_FILE?: string | undefined;
  CLOUDFLARE_ACCOUNT_ID?: string | undefined;
  ROUTES_KV_NAMESPACE_ID?: string | undefined;
  CLOUDFLARE_API_TOKEN?: string | undefined;
}

/** `ROUTE_STORE=memory|file|cloudflare-kv`; unset is `memory`. A setting that is missing is an error, not a quiet fallback. */
export function routeStoreFromEnv(env: RouteStoreEnv): RouteStore {
  const kind = env.ROUTE_STORE?.trim() || 'memory';
  const need = (name: keyof RouteStoreEnv): string => {
    const value = env[name];
    if (!value) throw new Error(`ROUTE_STORE=${kind} needs ${name}`);
    return value;
  };
  if (kind === 'memory') return new MemoryRouteStore();
  if (kind === 'file') return new FileRouteStore(need('ROUTES_FILE'));
  if (kind === 'cloudflare-kv') return new CloudflareKvRouteStore({ accountId: need('CLOUDFLARE_ACCOUNT_ID'), namespaceId: need('ROUTES_KV_NAMESPACE_ID'), apiToken: need('CLOUDFLARE_API_TOKEN') });
  throw new Error(`ROUTE_STORE must be memory, file or cloudflare-kv, got ${JSON.stringify(kind)}`);
}

const LAMBDA_URL_HOST = /^[^.]+\.lambda-url\.([a-z0-9-]+)\.on\.aws$/;

/** Where a deployed version is served, or undefined for a version without a function URL (the local driver). */
export function routeTarget(resources: DeployResources): AppRouteTarget | undefined {
  if (!resources.functionUrl) return undefined;
  const url = new URL(resources.functionUrl);
  // The Router signs a request for the function's own region, which the URL names.
  const region = LAMBDA_URL_HOST.exec(url.hostname)?.[1];
  return { origin: url.origin, ...(region ? { region } : {}) };
}

/** The app's entry as the control DB has it now: the active version of each env. */
export async function appRoute(db: Executor, app: string): Promise<AppRoute> {
  const route: AppRoute = {};
  for (const env of ENV_NAMES satisfies readonly EnvName[]) {
    const target = routeTarget((await loadEnv(db, app, env)).version?.resources ?? {});
    if (target) route[env] = target;
  }
  return route;
}
