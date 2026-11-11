import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppRoute, routeKey } from '@kelay/contracts';
import type { DeployDriver, DeployInput, DeployResult } from '../src/deploy/driver.ts';
import { CloudflareKvRouteStore, FileRouteStore, MemoryRouteStore, routeStoreFromEnv, routeTarget, type RouteStore } from '../src/deploy/routes.ts';
import { createHarness, seedApp, type Harness } from './harness.ts';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const NAMESPACE = 'fedcba9876543210fedcba9876543210';
const DEV_URL = 'https://devfn456.lambda-url.ap-northeast-2.on.aws/';
const PROD_URL = 'https://prodfn123.lambda-url.ap-northeast-2.on.aws/';
const route: AppRoute = { dev: { origin: 'https://devfn456.lambda-url.ap-northeast-2.on.aws', region: 'ap-northeast-2' } };

describe('route stores', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kelay-routes-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes one KV value per app through the Cloudflare API, with the token from the environment', async () => {
    const calls: { method: string; url: string; auth: string | null; type: string | null; body: string | null }[] = [];
    const store = new CloudflareKvRouteStore({
      accountId: ACCOUNT,
      namespaceId: NAMESPACE,
      apiToken: 'kv-token',
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({ method: init?.method ?? 'GET', url: String(input), auth: headers.get('authorization'), type: headers.get('content-type'), body: typeof init?.body === 'string' ? init.body : null });
        return Response.json({ success: true, errors: [], messages: [], result: null });
      }) as typeof fetch,
    });
    await store.put('orum', 'ticket-board', route);
    await store.delete('orum', 'ticket-board');

    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/values/app%3Aorum%2Fticket-board`;
    expect(calls).toEqual([
      { method: 'PUT', url, auth: 'Bearer kv-token', type: 'text/plain', body: JSON.stringify(route) },
      { method: 'DELETE', url, auth: 'Bearer kv-token', type: null, body: null },
    ]);
    // The Router parses the value with the same schema, under the same key.
    expect(decodeURIComponent(url.split('/values/')[1]!)).toBe(routeKey('orum', 'ticket-board'));
    expect(AppRoute.parse(JSON.parse(calls[0]!.body!))).toEqual(route);
  });

  it('reports what Cloudflare answered, and never writes an entry the Router could not parse', async () => {
    const answers: Response[] = [
      Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 }),
      new Response('bad gateway', { status: 502 }),
      Response.json({ success: false, errors: [{ code: 10009, message: 'key not found' }] }, { status: 404 }),
    ];
    let sent = 0;
    const store = new CloudflareKvRouteStore({
      accountId: ACCOUNT,
      namespaceId: NAMESPACE,
      apiToken: 'kv-token',
      fetch: (async () => {
        sent++;
        const next = answers.shift();
        if (!next) throw new TypeError('fetch failed');
        return next;
      }) as typeof fetch,
    });
    await expect(store.put('orum', 'ticket-board', route)).rejects.toThrow('Cloudflare KV refused PUT app:orum/ticket-board: 10000 Authentication error');
    await expect(store.put('orum', 'ticket-board', route)).rejects.toThrow('HTTP 502');
    // An entry that is already gone is what a delete wants.
    await store.delete('orum', 'ticket-board');
    await expect(store.put('orum', 'ticket-board', route)).rejects.toThrow('Cloudflare KV could not be reached for app:orum/ticket-board: fetch failed');

    await expect(store.put('orum', 'ticket-board', { prod: { origin: 'ftp://x' } })).rejects.toThrow();
    expect(sent).toBe(4);
    expect(() => new CloudflareKvRouteStore({ accountId: 'nope', namespaceId: NAMESPACE, apiToken: 't' })).toThrow('account id must be 32 hexadecimal characters');
  });

  it('keeps the table in a file or in memory for runs without Cloudflare', async () => {
    const file = join(dir, 'nested/routes.json');
    const store = new FileRouteStore(file);
    await Promise.all([store.put('orum', 'ticket-board', route), store.put('orum', 'wiki', { prod: { origin: 'http://localhost:3000' } })]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'app:orum/ticket-board': route, 'app:orum/wiki': { prod: { origin: 'http://localhost:3000' } } });
    await store.delete('orum', 'wiki');
    await store.delete('orum', 'never-there');
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['app:orum/ticket-board']);

    const memory = new MemoryRouteStore();
    await memory.put('orum', 'ticket-board', route);
    expect(memory.routes.get('app:orum/ticket-board')).toEqual(route);
    await memory.delete('orum', 'ticket-board');
    expect(memory.routes.size).toBe(0);
  });

  it('is chosen by ROUTE_STORE and refuses a half-configured store', () => {
    expect(routeStoreFromEnv({}).name).toBe('memory');
    expect(routeStoreFromEnv({ ROUTE_STORE: 'file', ROUTES_FILE: join(dir, 'r.json') }).name).toBe('file');
    expect(routeStoreFromEnv({ ROUTE_STORE: 'cloudflare-kv', CLOUDFLARE_ACCOUNT_ID: ACCOUNT, ROUTES_KV_NAMESPACE_ID: NAMESPACE, CLOUDFLARE_API_TOKEN: 't' }).name).toBe('cloudflare-kv');
    expect(() => routeStoreFromEnv({ ROUTE_STORE: 'cloudflare-kv', CLOUDFLARE_ACCOUNT_ID: ACCOUNT, ROUTES_KV_NAMESPACE_ID: NAMESPACE })).toThrow('ROUTE_STORE=cloudflare-kv needs CLOUDFLARE_API_TOKEN');
    expect(() => routeStoreFromEnv({ ROUTE_STORE: 'file' })).toThrow('needs ROUTES_FILE');
    expect(() => routeStoreFromEnv({ ROUTE_STORE: 'dynamodb' })).toThrow('must be memory, file or cloudflare-kv');
  });

  it('takes the origin and the signing region from the function URL', () => {
    expect(routeTarget({ functionUrl: 'https://abc123.lambda-url.us-west-2.on.aws/' })).toEqual({ origin: 'https://abc123.lambda-url.us-west-2.on.aws', region: 'us-west-2' });
    expect(routeTarget({ functionUrl: 'http://localhost:3000/' })).toEqual({ origin: 'http://localhost:3000' });
    expect(routeTarget({})).toBeUndefined();
  });
});

/** A deploy driver that answers a function URL per env, as the aws driver does, without AWS. */
class UrlDriver implements DeployDriver {
  readonly name = 'aws';
  async deploy(input: DeployInput): Promise<DeployResult> {
    return { lambdaVersion: String(input.number), resources: { functionName: `kelay-app-${input.app}-${input.env}-web`, functionUrl: input.env === 'dev' ? DEV_URL : PROD_URL }, callerTokenRef: 'lambda-env' };
  }
  async activate(): Promise<void> {}
}

describe('routes published by deploy and publish', () => {
  const APP = 'ticket-board';
  const KEY = 'app:h-jeongyun/ticket-board';
  const routes = new MemoryRouteStore();
  let failing: string | null = null;
  const store: RouteStore = {
    name: 'cloudflare-kv',
    put: async (handle, app, entry) => {
      if (failing) throw new Error(failing);
      await routes.put(handle, app, entry);
    },
    delete: (handle, app) => routes.delete(handle, app),
  };
  let h: Harness;
  let builder: string;
  const build = (commit: string) => ({ commit, artifactUrl: `s3://kelay-artifacts/builds/${APP}/${commit}/web.zip`, configVersion: `cfg-${commit}` });

  beforeAll(async () => {
    h = await createHarness({ deploy: new UrlDriver(), routes: store });
    builder = await seedApp(h, 'jeongyun', APP);
  });
  afterAll(() => h.close());

  it('writes the dev target on the first deploy, so the app answers on the dev host before it is published', async () => {
    const dev = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: build('a1') });
    expect(dev.status).toBe(201);
    expect(dev.body.route).toEqual({ key: KEY, published: true });
    expect(routes.routes.get(KEY)).toEqual({ dev: { origin: 'https://devfn456.lambda-url.ap-northeast-2.on.aws', region: 'ap-northeast-2' } });
    expect((await h.req('GET', '/healthz')).body).toMatchObject({ routeStore: 'cloudflare-kv' });
  });

  it('adds the prod target on publish and keeps the dev one', async () => {
    const [version] = (await h.req('GET', `/v1/apps/${APP}/versions?env=dev`, { token: builder })).body.versions;
    const prod = await h.req('POST', `/v1/apps/${APP}/publish`, { token: builder, body: { versionId: version.id } });
    expect(prod.status).toBe(200);
    expect(prod.body.route).toEqual({ key: KEY, published: true });
    expect(routes.routes.get(KEY)).toEqual({
      dev: { origin: 'https://devfn456.lambda-url.ap-northeast-2.on.aws', region: 'ap-northeast-2' },
      prod: { origin: 'https://prodfn123.lambda-url.ap-northeast-2.on.aws', region: 'ap-northeast-2' },
    });
  });

  it('keeps the deploy when the table cannot be written, and says so', async () => {
    failing = 'Cloudflare KV refused PUT app:h-jeongyun/ticket-board: 10000 Authentication error';
    const dev = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: build('b2') });
    expect(dev.status).toBe(201);
    expect(dev.body.version).toMatchObject({ number: 2, commit: 'b2' });
    expect(dev.body.route).toEqual({ key: KEY, published: false, error: failing });
    failing = null;

    // The next deploy writes the whole entry again.
    routes.routes.clear();
    const again = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: build('c3') });
    expect(again.body.route).toEqual({ key: KEY, published: true });
    expect(Object.keys(routes.routes.get(KEY)!).sort()).toEqual(['dev', 'prod']);
  });

  it('takes an archived app off the Router', async () => {
    expect((await h.req('DELETE', `/v1/apps/${APP}`, { token: builder })).status).toBe(200);
    expect(routes.routes.has(KEY)).toBe(false);
  });

  it('publishes nothing for a deploy without a function URL', async () => {
    const local = await createHarness({ routes: store });
    try {
      const token = await seedApp(local, 'jeongyun', 'local-app');
      const dev = await local.req('POST', '/v1/apps/local-app/envs/dev/deploy', { token, body: build('a1') });
      expect(dev.status).toBe(201);
      expect(dev.body.route).toBeUndefined();
      expect(routes.routes.size).toBe(0);
    } finally {
      await local.close();
    }
  });
});
