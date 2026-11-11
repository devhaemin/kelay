// Checks the Builder image (services/builder/Dockerfile) without an AWS account. It needs Docker and
// an image built for this machine:
//
//   docker build -f services/builder/Dockerfile -t kelay/workspace .
//   pnpm --filter @kelay/builder verify:image -- --image kelay/workspace
//
// Two runs, both with the scripted agent and a Control API stub in this process:
//   task     the image as the fargate driver starts it: the workspace runtime in the container, driven
//            from here over the runtime protocol. A turn builds the bundles in the container, they are
//            fetched and stored here, and the stub receives the deploy. The web bundle then answers a
//            request in the Lambda runtime emulator, and the dev preview answers in the container.
//   service  the image as the Builder service: a build started over its HTTP API, deployed to the stub,
//            and the app's `next dev` reached through the preview proxy the way a browser frame does:
//            the page, one of its scripts, and the HMR WebSocket.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { CALLER_HEADER, audienceForApp } from '@kelay/contracts';
import { createDevSigner, verifyCallerToken } from '@kelay/tokens';
import { execa } from 'execa';
import getPort from 'get-port';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import { CONSOLE_APP } from '../src/app.ts';
import { LocalArtifactStore } from '../src/artifacts/store.ts';
import { ControlClient, type DeployRequest } from '../src/control.ts';
import { RemoteWorkspace } from '../src/drivers/runtime.ts';
import type { WorkspaceDriver } from '../src/drivers/types.ts';
import { createLogger } from '../src/log.ts';
import { WorkspaceManager } from '../src/workspaces.ts';

const { values } = parseArgs({ options: { image: { type: 'string', default: 'kelay/workspace' }, only: { type: 'string' } }, allowPositionals: true });
const IMAGE = values.image ?? 'kelay/workspace';
const LAMBDA_IMAGE = 'public.ecr.aws/lambda/nodejs:22';
const APP = 'team-board';
const HANDLE = 'orum';
const OWNER = 'builder-1';
const CALLER_SECRET = 'verify-image-caller-secret-0123456789abcdef';
const RUNTIME_TOKEN = 'verify-image-runtime-token';

const containers: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'kelay-verify-image-'));
const say = (line: string) => console.log(line);

function check(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`failed: ${what}`);
  say(`  ok  ${what}`);
}

async function docker(...args: string[]): Promise<string> {
  return (await execa('docker', args)).stdout.trim();
}

async function startContainer(name: string, args: string[], command: string[] = []): Promise<void> {
  await execa('docker', ['rm', '-f', name], { reject: false });
  containers.push(name);
  await docker('run', '-d', '--name', name, ...args, IMAGE, ...command);
}

async function waitFor(url: string, name: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      await res.body?.cancel();
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    const state = await docker('inspect', '-f', '{{.State.Running}}', name).catch(() => 'false');
    if (state !== 'true') throw new Error(`${name} stopped while starting:\n${(await execa('docker', ['logs', '--tail', '40', name], { reject: false, all: true })).all}`);
    await sleep(500);
  }
  throw new Error(`${url} did not answer in time`);
}

/** The Control API as the Builder calls it, plus the JWKS a Builder in a container verifies tokens with. */
async function startStub() {
  const signer = await createDevSigner('http://kelay-id.verify');
  const deploys: { app: string; request: DeployRequest; caller: string }[] = [];
  const members: { app: string; userId: string; org: string; role: string }[] = [];
  const stub = new Hono();
  stub.get('/jwks', (c) => c.json(signer.jwks));
  stub.get('/v1/apps/:app', (c) => c.json({ app: { slug: c.req.param('app'), handle: HANDLE, name: 'Team Board', owner: OWNER }, envs: [{ name: 'dev', activeVersion: null }] }));
  stub.post('/v1/apps/:app/envs/dev/deploy', async (c) => {
    const claims = await verifyCallerToken(c.req.header(CALLER_HEADER) ?? '', CALLER_SECRET);
    deploys.push({ app: c.req.param('app'), request: await c.req.json<DeployRequest>(), caller: String(claims.svc ?? claims.kind) });
    return c.json({ version: { id: `00000000-0000-4000-8000-00000000000${deploys.length}`, label: `v${deploys.length}` }, callerToken: 'app-runtime-token' }, 201);
  });
  stub.put('/internal/v1/sandboxes', (c) => c.body(null, 204));
  stub.put('/internal/v1/apps/:app/members/:userId', async (c) => {
    members.push({ app: c.req.param('app'), userId: c.req.param('userId'), ...(await c.req.json<{ org: string; role: string }>()) });
    return c.json({ member: {} });
  });
  stub.post('/internal/v1/improvement-runs/claim', (c) => c.json({ run: null }));
  const port = await getPort();
  // On every interface: the Builder in the second run reaches it from inside a container.
  const server = serve({ fetch: stub.fetch, port, hostname: '0.0.0.0' });
  return { signer, deploys, members, port, close: () => server.close() };
}

function checkDeploy(deploy: { app: string; request: DeployRequest; caller: string } | undefined, urls: RegExp) {
  check(deploy?.app === APP && deploy.caller === 'builder', 'the stub received the deploy as the builder service');
  const request = deploy!.request;
  check(urls.test(request.artifactUrl) && request.artifactUrl.endsWith('/web.zip'), `the deploy names the web bundle (${request.artifactUrl})`);
  check(request.nodesArtifactUrl?.endsWith('/nodes.zip'), `the deploy names the node bundle (${request.nodesArtifactUrl ?? 'none'})`);
  check(request.schema.app === APP && request.graphs.map((g) => g.name).join() === 'overdue-summary', 'the deploy carries the checked schema and the compiled graph');
}

async function task(stub: Awaited<ReturnType<typeof startStub>>) {
  say('\nThe workspace task, driven over the runtime protocol');
  const [runtimePort, previewPort] = [await getPort(), await getPort()];
  const name = 'kelay-verify-workspace';
  await startContainer(name, ['-p', `127.0.0.1:${runtimePort}:4007`, '-p', `127.0.0.1:${previewPort}:3000`, '-e', `KELAY_APP=${APP}`, '-e', `KELAY_RUNTIME_TOKEN=${RUNTIME_TOKEN}`, '-e', 'BUILDER_AGENT=scripted']);
  await waitFor(`http://127.0.0.1:${runtimePort}/healthz`, name);
  check((await docker('exec', name, 'id', '-u')) === '1000', 'the task runs as uid 1000, the owner of the EFS access points');

  const store = join(scratch, 'store');
  const driver: WorkspaceDriver = {
    name: 'fargate',
    exists: async () => false,
    open: (app) =>
      new RemoteWorkspace({ app, ref: `docker:${name}`, endpoint: `http://127.0.0.1:${runtimePort}`, token: RUNTIME_TOKEN, previewTarget: `http://127.0.0.1:${previewPort}`, stop: async () => {} }).connect(),
  };
  const workspaces = new WorkspaceManager({
    driver,
    control: new ControlClient({ baseUrl: `http://127.0.0.1:${stub.port}`, callerSecret: CALLER_SECRET }),
    agent: { kind: 'scripted', model: null },
    stateDir: join(scratch, 'state'),
    artifacts: new LocalArtifactStore(store),
    logger: createLogger('silent'),
    idleMs: 0,
  });
  const started = Date.now();
  const { done } = await workspaces.start({ slug: APP, handle: HANDLE, name: 'Team Board', owner: OWNER, deployedToDev: false }, { id: OWNER, org: 'orum' }, 'A ticket board for my team');
  const result = await done;
  const events = workspaces.events(APP).since(0);
  check(result.status === 'succeeded', `the turn succeeded in ${Math.round((Date.now() - started) / 1000)}s (${result.error ?? 'no error'})`);
  check(events.some((e) => e.type === 'build' && e.ok), 'the bundles were built in the container');
  checkDeploy(stub.deploys.at(-1), /^file:/);

  const web = fileURLToPath(stub.deploys.at(-1)!.request.artifactUrl);
  const fn = join(scratch, 'fn');
  await execa('unzip', ['-q', web, '-d', fn]);
  const emulator = 'kelay-verify-lambda';
  const emulatorPort = await getPort();
  await execa('docker', ['rm', '-f', emulator], { reject: false });
  containers.push(emulator);
  await docker('run', '-d', '--name', emulator, '-p', `127.0.0.1:${emulatorPort}:8080`, '-v', `${fn}:/var/task:ro`, LAMBDA_IMAGE, 'index.handler');
  const path = `/${HANDLE}/${APP}`;
  const event = { version: '2.0', routeKey: '$default', rawPath: path, rawQueryString: '', headers: { host: 'x.lambda-url.ap-northeast-2.on.aws', accept: 'text/html' }, requestContext: { http: { method: 'GET', path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.7', userAgent: 'verify-image' }, domainName: 'x.lambda-url.ap-northeast-2.on.aws', requestId: 'r1', stage: '$default', timeEpoch: 0 }, isBase64Encoded: false };
  let answer: { statusCode?: number; body?: string } = {};
  for (let i = 0; i < 60; i++) {
    try {
      answer = (await (await fetch(`http://127.0.0.1:${emulatorPort}/2015-03-31/functions/function/invocations`, { method: 'POST', body: JSON.stringify(event) })).json()) as typeof answer;
      break;
    } catch {
      await sleep(500);
    }
  }
  check(answer.statusCode === 200 && answer.body?.includes('<title>Ticket Board</title>'), `the web bundle answers GET ${path} with 200 in the Lambda runtime emulator`);

  const preview = await fetch(`http://127.0.0.1:${previewPort}/`, { signal: AbortSignal.timeout(120_000) });
  check(preview.status === 200 && (await preview.text()).includes('Ticket Board'), 'the dev preview in the task answers with the board page');
}

async function service(stub: Awaited<ReturnType<typeof startStub>>) {
  say('\nThe Builder service in the container');
  const port = await getPort();
  const name = 'kelay-verify-builder';
  const host = 'host.docker.internal';
  await startContainer(
    name,
    [
      '-p', `127.0.0.1:${port}:4006`,
      '--add-host', `${host}:host-gateway`,
      '-e', 'PORT=4006',
      '-e', `CONTROL_API_URL=http://${host}:${stub.port}`,
      '-e', `KELAY_CALLER_SECRET=${CALLER_SECRET}`,
      '-e', `KELAY_ID_ISSUER=${stub.signer.issuer}`,
      '-e', `KELAY_ID_JWKS_URL=http://${host}:${stub.port}/jwks`,
      '-e', 'BUILDER_AGENT=scripted',
      '-e', 'BUILDER_ARTIFACT_STORE=local',
      '-e', 'BUILDER_IMPROVEMENTS=off',
      // The address a browser on this machine reaches the container's proxy at.
      '-e', `BUILDER_PREVIEW_URL_TEMPLATE=http://127.0.0.1:${port}/preview/{app}/`,
    ],
    ['node', '--import', 'tsx', 'src/server.ts'],
  );
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/healthz`, name);
  const health = (await (await fetch(`${base}/healthz`)).json()) as { driver?: string; agent?: { kind?: string } };
  check(health.driver === 'local' && health.agent?.kind === 'scripted', 'the service answers /healthz');

  const token = await stub.signer.sign({ sub: OWNER, app: CONSOLE_APP, aud: audienceForApp(CONSOLE_APP), org: 'orum', role: 'builder', plan: 'pro' });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const before = stub.deploys.length;
  const start = await fetch(`${base}/v1/workspaces`, { method: 'POST', headers, body: JSON.stringify({ app: APP, prompt: 'A ticket board for my team' }) });
  check(start.status === 202, 'POST /v1/workspaces starts the first build');
  type Event = { type: string; status?: string; error?: string | null };
  let finished: Event | undefined;
  for (let i = 0; i < 600 && !finished; i++) {
    await sleep(500);
    const { events } = (await (await fetch(`${base}/v1/workspaces/${APP}/events?format=json`, { headers })).json()) as { events: Event[] };
    finished = events.find((e) => e.type === 'turn.finished');
  }
  check(finished?.status === 'succeeded', `the turn succeeded (${finished?.error ?? 'no error'})`);
  check(stub.deploys.length === before + 1, 'the build was deployed once');
  check(stub.members.some((m) => m.app === APP && m.userId === OWNER && m.role === 'admin'), 'the builder became an admin member of the app');
  checkDeploy(stub.deploys.at(-1), /^file:\/\/\/var\/lib\/kelay-builder\/artifacts\/builds\/team-board\//);

  // The preview, as the console's frame loads it. The browser's own origin is not the dev server's.
  const origin = 'https://preview.kelay.example';
  const { preview } = (await (await fetch(`${base}/v1/workspaces/${APP}/preview`, { method: 'POST', headers })).json()) as { preview: { url: string } | null };
  check(preview?.url.startsWith(`${base}/preview/${APP}/?`), 'the Builder answers the preview address with a ticket');
  check((await fetch(`${base}/preview/${APP}/`, { redirect: 'manual' })).status === 401, 'the preview refuses a request without a session');
  const landing = await fetch(preview!.url, { redirect: 'manual' });
  const cookie = landing.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  check(landing.status === 302 && landing.headers.get('location') === `/preview/${APP}/` && cookie.includes('kelay_ps_'), 'the ticket becomes a session cookie');
  const page = await fetch(`${base}/preview/${APP}/`, { headers: { cookie }, signal: AbortSignal.timeout(120_000) });
  const html = await page.text();
  check(page.status === 200 && html.includes('Ticket Board'), 'the proxy serves the board page from `next dev`');
  const script = /src="(\/_next\/[^"]+\.js[^"]*)"/.exec(html)?.[1];
  check(script, `the page loads its scripts from the root (${script ?? 'none found'})`);
  const asset = await fetch(`${base}${script!}`, { headers: { cookie, referer: `${origin}/preview/${APP}/`, 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'same-origin' } });
  check(asset.status === 200 && (asset.headers.get('content-type') ?? '').includes('javascript'), 'a script of the page comes through the proxy');
  await asset.body?.cancel();

  const hmr = await new Promise<string>((ok, fail) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/_next/hmr?id=verify`, { headers: { cookie, origin } });
    const timer = setTimeout(() => fail(new Error('the HMR socket opened but sent nothing in 30 s')), 30_000);
    socket.on('message', (data) => {
      clearTimeout(timer);
      socket.close();
      ok(data.toString());
    });
    socket.on('unexpected-response', (_req, res) => fail(new Error(`the HMR socket was refused with ${res.statusCode}`)));
    socket.on('error', fail);
  });
  check(hmr.length > 0, `the HMR WebSocket of \`next dev\` connects through the proxy (first message: ${hmr.slice(0, 60)})`);
  const refused = await new Promise<number>((ok) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/preview/${APP}/_next/hmr`);
    socket.on('unexpected-response', (_req, res) => ok(res.statusCode ?? 0));
    socket.on('open', () => ok(101));
    socket.on('error', () => ok(0));
  });
  check(refused === 401, 'the HMR WebSocket refuses a browser without a session');
}

const stub = await startStub();
let failed = false;
try {
  if (!values.only || values.only === 'task') await task(stub);
  if (!values.only || values.only === 'service') await service(stub);
  say('\nThe image passed.');
} catch (e) {
  failed = true;
  console.error(`\n${(e as Error).message}`);
  for (const name of containers) {
    const logs = await execa('docker', ['logs', '--tail', '30', name], { reject: false, all: true });
    console.error(`\n--- ${name} ---\n${logs.all}`);
  }
} finally {
  stub.close();
  for (const name of containers) await execa('docker', ['rm', '-f', name], { reject: false });
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
