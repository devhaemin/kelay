import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { previewBearer } from '../src/app.ts';
import { createBuilderServer } from '../src/http.ts';
import { PreviewProxy } from '../src/preview/proxy.ts';
import { PreviewSessions, TICKET_PARAM } from '../src/preview/session.ts';
import { createHarness, type Harness } from './harness.ts';

const SECRET = 'preview-test-secret-0123456789abcdefghij';
const APP = 'team-board';

/** Stands in for a workspace's `next dev`: it answers with what it was asked, and echoes on its HMR socket. */
function fakeDevServer(name: string) {
  const seen: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (req.url === '/old') {
      res.writeHead(307, { location: '/new?x=1' }).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json', 'set-cookie': 'app_theme=dark; Path=/' });
      res.end(JSON.stringify({ server: name, method: req.method, url: req.url, body }));
    });
  });
  const sockets = new WebSocketServer({ server, path: '/_next/hmr' });
  const upgrades: IncomingHttpHeaders[] = [];
  sockets.on('connection', (socket, req) => {
    upgrades.push(req.headers);
    socket.send(`hello from ${name}`);
    socket.on('message', (data) => socket.send(`echo:${data.toString()}`));
  });
  return { server, seen, upgrades, sockets };
}

/** A request with a Host header of its own, which fetch does not allow. */
function onHost(port: number, host: string, path: string, cookie?: string): Promise<{ status: number; location: string | undefined; setCookie: string[]; body: any }> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host, ...(cookie ? { cookie } : {}) } }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => (text += chunk.toString()));
      res.on('end', () => ok({ status: res.statusCode ?? 0, location: res.headers.location, setCookie: res.headers['set-cookie'] ?? [], body: text ? JSON.parse(text) : null }));
    });
    req.on('error', fail);
    req.end();
  });
}

const listen = (server: Server) => new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)));

/** Opens a socket and collects what arrives. Rejects with the HTTP status when the upgrade is refused. */
function connect(url: string, headers: Record<string, string>): Promise<{ socket: WebSocket; messages: string[]; next(): Promise<string> }> {
  return new Promise((ok, fail) => {
    const socket = new WebSocket(url, { headers });
    const messages: string[] = [];
    const waiting: ((message: string) => void)[] = [];
    socket.on('message', (data) => {
      const waiter = waiting.shift();
      if (waiter) waiter(data.toString());
      else messages.push(data.toString());
    });
    socket.on('open', () => ok({ socket, messages, next: () => new Promise<string>((got) => (messages.length > 0 ? got(messages.shift()!) : waiting.push(got))) }));
    socket.on('unexpected-response', (_req, res) => fail(new Error(`upgrade refused: ${res.statusCode}`)));
    socket.on('error', fail);
  });
}

describe('the preview proxy', () => {
  let h: Harness;
  let server: Server;
  let base: string;
  let port: number;
  let owner: string;
  const board = fakeDevServer('team-board');
  const wiki = fakeDevServer('team-wiki');
  const targets = new Map<string, string>();
  const sessions = new PreviewSessions(SECRET);

  const call = (path: string, init: { headers?: Record<string, string>; method?: string; body?: string } = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init });
  const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');
  /** What the console does: asks for the frame's address, and the browser follows it once. */
  const open = async (app: string, token = owner) => {
    const res = await fetch(`${base}/v1/workspaces/${app}/preview`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const { preview } = (await res.json()) as { preview: { url: string; expiresAt: string } };
    const landing = await fetch(preview.url, { redirect: 'manual' });
    return { preview, landing, cookie: cookiesOf(landing) };
  };

  beforeAll(async () => {
    h = await createHarness();
    for (const app of [APP, 'team-wiki', 'stopped-app']) h.control.addApp(app, 'jeongyun');
    h.control.addApp('other-board', 'someone-else');
    owner = await h.token('jeongyun');
    targets.set(APP, `http://127.0.0.1:${await listen(board.server)}`);
    targets.set('team-wiki', `http://127.0.0.1:${await listen(wiki.server)}`);

    // The real API and the real proxy on one port, as src/server.ts runs them; only the workspaces are
    // replaced, by the two fake dev servers.
    const api = (await import('../src/app.ts')).createBuilderApi({
      auth: { issuer: h.signer.issuer, jwks: h.signer.verifier },
      control: h.control,
      workspaces: { status: async (app: string) => (h.control.apps.has(app) ? { app, previewUrl: targets.has(app) ? `${base}/preview/${app}/` : null } : null) } as never,
      preview: sessions,
      logger: (await import('../src/log.ts')).createLogger('silent'),
    });
    const proxy = new PreviewProxy({
      sessions,
      target: (app) => targets.get(app) ?? null,
      bearer: previewBearer({ auth: { issuer: h.signer.issuer, jwks: h.signer.verifier }, control: h.control }),
      domain: 'preview.kelay.test',
      logger: (await import('../src/log.ts')).createLogger('silent'),
    });
    server = createBuilderServer(api, proxy);
    port = await listen(server);
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const s of [server, board.server, wiki.server]) {
      s.closeAllConnections();
      s.close();
    }
    await h.close();
  });

  it('gives the owner a ticket that the proxy trades for a cookie on its own origin', async () => {
    const { preview, landing, cookie } = await open(APP);
    expect(new URL(preview.url).pathname).toBe(`/preview/${APP}/`);
    expect(new URL(preview.url).searchParams.get(TICKET_PARAM)).toEqual(expect.any(String));
    expect(Date.parse(preview.expiresAt)).toBeGreaterThan(Date.now());

    // The ticket leaves the address bar at once, and the app never sees it.
    expect(landing.status).toBe(302);
    expect(landing.headers.get('location')).toBe(`/preview/${APP}/`);
    expect(landing.headers.get('referrer-policy')).toBe('no-referrer');
    const set = landing.headers.getSetCookie();
    expect(set).toHaveLength(2);
    for (const c of set) expect(c).toMatch(/; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax$/);
    expect(board.seen).toHaveLength(0);

    const page = await call(`/preview/${APP}/tickets/7?tab=comments`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ server: 'team-board', method: 'GET', url: '/tickets/7?tab=comments', body: '' });
    // What the app sets passes through untouched.
    expect(page.headers.getSetCookie()).toEqual(['app_theme=dark; Path=/']);
  });

  it('refuses everyone else', async () => {
    const stranger = await h.token('someone-else');
    expect((await fetch(`${base}/v1/workspaces/${APP}/preview`, { method: 'POST', headers: { authorization: `Bearer ${stranger}` } })).status).toBe(403);
    expect((await fetch(`${base}/v1/workspaces/${APP}/preview`, { method: 'POST' })).status).toBe(401);

    const before = board.seen.length;
    const none = await call(`/preview/${APP}/`);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: { code: 'unauthenticated' } });

    // A ticket or a session for another app, an expired or forged one, a session used as a ticket.
    const mine = await open('team-wiki');
    expect((await call(`/preview/${APP}/`, { headers: { cookie: mine.cookie } })).status).toBe(401);
    const wikiTicket = new URL(mine.preview.url).searchParams.get(TICKET_PARAM)!;
    expect((await call(`/preview/${APP}/?${TICKET_PARAM}=${wikiTicket}`)).status).toBe(401);
    const expired = await sessions.ticket({ app: APP, sub: 'jeongyun' }, -10);
    expect((await call(`/preview/${APP}/?${TICKET_PARAM}=${expired}`)).status).toBe(401);
    // A reloaded frame sends its old ticket again: the session it got from it still counts.
    const reload = await call(`/preview/${APP}/tickets?${TICKET_PARAM}=${expired}`, { headers: { cookie: (await open(APP)).cookie } });
    expect(reload.status).toBe(302);
    expect(reload.headers.get('location')).toBe(`/preview/${APP}/tickets`);
    expect(reload.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual(['kelay_pc']);
    expect((await call(`/preview/${APP}/?${TICKET_PARAM}=${await new PreviewSessions(`${SECRET}-other`).ticket({ app: APP, sub: 'jeongyun' })}`)).status).toBe(401);
    expect((await call(`/preview/${APP}/?${TICKET_PARAM}=${await sessions.session({ app: APP, sub: 'jeongyun' })}`)).status).toBe(401);
    expect((await call(`/preview/${APP}/`, { headers: { cookie: `kelay_ps_${APP}=${await sessions.ticket({ app: APP, sub: 'jeongyun' })}` } })).status).toBe(401);

    // The builder's own token works without a ticket, for the owner only.
    expect((await call(`/preview/${APP}/`, { headers: { authorization: `Bearer ${stranger}` } })).status).toBe(401);
    expect((await call('/preview/other-board/', { headers: { authorization: `Bearer ${owner}` } })).status).toBe(401);
    expect(board.seen).toHaveLength(before);
    expect((await call(`/preview/${APP}/`, { headers: { authorization: `Bearer ${owner}` } })).status).toBe(200);
  });

  it('hands the dev server a request that looks local, without the builder’s token or the proxy’s cookies', async () => {
    const { cookie } = await open(APP);
    board.seen.length = 0;
    const res = await call(`/preview/${APP}/api/kelay/v1/apps/${APP}/query`, {
      method: 'POST',
      body: '{"op":"list"}',
      headers: {
        cookie: `${cookie}; app_theme=dark`,
        authorization: `Bearer ${owner}`,
        origin: 'https://preview.kelay.example',
        referer: `https://preview.kelay.example/preview/${APP}/tickets?open=1`,
        'x-kelay-authorization': 'Bearer forged',
        'content-type': 'application/json',
      },
    });
    expect(await res.json()).toMatchObject({ method: 'POST', url: `/api/kelay/v1/apps/${APP}/query`, body: '{"op":"list"}' });
    const devPort = new URL(targets.get(APP)!).port;
    const { headers } = board.seen[0]!;
    expect(headers).toMatchObject({ host: `localhost:${devPort}`, origin: `http://localhost:${devPort}`, referer: `http://localhost:${devPort}/tickets?open=1`, cookie: 'app_theme=dark', 'content-type': 'application/json' });
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-kelay-authorization']).toBeUndefined();
    // The app learns the address the browser has for it, for its sign-in link; a browser cannot forge it.
    expect(headers['x-kelay-preview-url']).toBe(`${base}/preview/${APP}/`);
    board.seen.length = 0;
    await call(`/preview/${APP}/`, { headers: { cookie, 'x-kelay-preview-url': 'https://evil.example/', 'x-forwarded-proto': 'https' } });
    expect(board.seen[0]!.headers['x-kelay-preview-url']).toBe(`https://127.0.0.1:${port}/preview/${APP}/`);
    expect(JSON.stringify(headers)).not.toContain('kelay_p');
  });

  it('serves what `next dev` asks for from the root to the app the browser has open', async () => {
    const { cookie } = await open(APP);
    board.seen.length = 0;
    const chunk = await call('/_next/static/chunks/app.js', { headers: { cookie } });
    expect(await chunk.json()).toMatchObject({ server: 'team-board', url: '/_next/static/chunks/app.js' });

    // The Builder's own routes are never sent to an app, and without a preview open nothing is.
    expect(await (await call('/healthz', { headers: { cookie } })).json()).toMatchObject({ service: 'builder' });
    expect((await call('/v1/workspaces/nope', { headers: { cookie } })).status).toBe(401);
    expect((await call('/_next/static/chunks/app.js')).status).toBe(404);
    expect(board.seen).toHaveLength(1);

    // Opening another app's preview moves the browser to it; the first app's session stays good.
    const wikiOpen = await open('team-wiki');
    const both = `${cookie.split('; ').filter((c) => c.startsWith('kelay_ps_')).join('; ')}; ${wikiOpen.cookie}`;
    expect(await (await call('/_next/static/chunks/app.js', { headers: { cookie: both } })).json()).toMatchObject({ server: 'team-wiki' });
    expect(await (await call(`/preview/${APP}/`, { headers: { cookie: both } })).json()).toMatchObject({ server: 'team-board' });
  });

  it('keeps redirects inside the preview and passes other statuses through', async () => {
    const { cookie } = await open(APP);
    const moved = await call(`/preview/${APP}/old`, { headers: { cookie } });
    expect(moved.status).toBe(307);
    expect(moved.headers.get('location')).toBe(`/preview/${APP}/new?x=1`);
    expect((await call(`/preview/${APP}/missing`, { headers: { cookie } })).status).toBe(404);
    expect(await (await call(`/preview/${APP}`, { headers: { cookie } })).json()).toMatchObject({ url: '/' });
  });

  it('proxies the HMR WebSocket both ways, for a session only', async () => {
    const { cookie } = await open(APP);
    const viaPath = await connect(`ws://127.0.0.1:${port}/preview/${APP}/_next/hmr`, { cookie, origin: 'https://preview.kelay.example' });
    expect(await viaPath.next()).toBe('hello from team-board');
    viaPath.socket.send('ping');
    expect(await viaPath.next()).toBe('echo:ping');
    viaPath.socket.close();

    // `next dev` opens its socket at the root; the cookie says which app it belongs to.
    const viaRoot = await connect(`ws://127.0.0.1:${port}/_next/hmr`, { cookie });
    expect(await viaRoot.next()).toBe('hello from team-board');
    viaRoot.socket.send('{"event":"ping"}');
    expect(await viaRoot.next()).toBe('echo:{"event":"ping"}');
    viaRoot.socket.close();

    const devPort = new URL(targets.get(APP)!).port;
    expect(board.upgrades[0]).toMatchObject({ host: `localhost:${devPort}`, origin: `http://localhost:${devPort}` });
    expect(board.upgrades.every((headers) => headers.cookie === undefined)).toBe(true);

    await expect(connect(`ws://127.0.0.1:${port}/preview/${APP}/_next/hmr`, {})).rejects.toThrow('upgrade refused: 401');
    await expect(connect(`ws://127.0.0.1:${port}/_next/hmr`, { cookie: `kelay_pc=${APP}` })).rejects.toThrow('upgrade refused: 401');
    await expect(connect(`ws://127.0.0.1:${port}/_next/hmr`, {})).rejects.toThrow('upgrade refused: 404');
    await expect(connect(`ws://127.0.0.1:${port}/v1/workspaces/${APP}/events`, { cookie })).rejects.toThrow('upgrade refused: 404');
    expect(board.upgrades).toHaveLength(2);
  });

  it('serves an app on its own host under the preview domain', async () => {
    const host = `${APP}.preview.kelay.test`;
    const ticket = await sessions.ticket({ app: APP, sub: 'jeongyun' });
    const landing = await onHost(port, host, `/board?${TICKET_PARAM}=${ticket}&view=list`);
    expect(landing).toMatchObject({ status: 302, location: '/board?view=list' });
    // One host per app needs no cookie that names the app.
    expect(landing.setCookie).toHaveLength(1);
    const cookie = landing.setCookie[0]!.split(';')[0]!;

    board.seen.length = 0;
    expect((await onHost(port, host, '/board?view=list', cookie)).body).toMatchObject({ server: 'team-board', url: '/board?view=list' });
    expect(board.seen[0]!.headers['x-kelay-preview-url']).toBe(`http://${host}/`);
    // On an app's host every path is the app's, also one the Builder has itself.
    expect((await onHost(port, `${host}:443`, '/healthz', cookie)).body).toMatchObject({ server: 'team-board', url: '/healthz' });
    expect((await onHost(port, 'team-wiki.preview.kelay.test', '/', cookie)).status).toBe(401);
    expect((await onHost(port, 'not_a_slug.preview.kelay.test', '/', cookie)).status).toBe(404);

    const socket = await connect(`ws://127.0.0.1:${port}/_next/hmr`, { host, cookie });
    expect(await socket.next()).toBe('hello from team-board');
    socket.socket.close();
  });

  it('says when the preview is not running or does not answer', async () => {
    const stopped = await fetch(`${base}/v1/workspaces/stopped-app/preview`, { method: 'POST', headers: { authorization: `Bearer ${owner}` } });
    expect(await stopped.json()).toEqual({ preview: null });
    const cookie = `kelay_ps_stopped-app=${await sessions.session({ app: 'stopped-app', sub: 'jeongyun' })}`;
    const idle = await call('/preview/stopped-app/', { headers: { cookie } });
    expect(idle.status).toBe(409);
    expect(await idle.json()).toMatchObject({ error: { code: 'conflict', message: expect.stringContaining('is not running') } });

    targets.set('stopped-app', 'http://127.0.0.1:9');
    const down = await call('/preview/stopped-app/', { headers: { cookie } });
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ error: { code: 'internal' } });
    await expect(connect(`ws://127.0.0.1:${port}/preview/stopped-app/_next/hmr`, { cookie })).rejects.toThrow();
  });
});
