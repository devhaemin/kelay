import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptedAgent } from '../src/agents/scripted.ts';
import { BuildError, buildAppArtifacts, type AppArtifacts } from '../src/artifacts/build.ts';
import { LocalArtifactStore, S3ArtifactStore, artifactKey, artifactStoreFromEnv } from '../src/artifacts/store.ts';
import { createWebHandler, type WebEvent } from '../src/artifacts/web-handler.ts';
import { LocalWorkspaceDriver } from '../src/drivers/local.ts';
import { TEMPLATE_DIR } from './harness.ts';

const BUILD_TIMEOUT = 300_000;
const root = mkdtempSync(join(tmpdir(), 'kelay-artifacts-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A Lambda function URL request, as the Router Worker's signed call arrives at the function. */
const urlEvent = (path: string, method = 'GET'): WebEvent => ({
  version: '2.0',
  routeKey: '$default',
  rawPath: path,
  rawQueryString: '',
  headers: { host: 'abc.lambda-url.ap-northeast-2.on.aws', accept: 'text/html' },
  requestContext: { accountId: 'anonymous', apiId: 'abc', domainName: 'abc.lambda-url.ap-northeast-2.on.aws', http: { method, path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.7', userAgent: 'vitest' }, requestId: 'r1', routeKey: '$default', stage: '$default', timeEpoch: 0 },
  isBase64Encoded: false,
});

/**
 * Unpacks a bundle the way Lambda does and calls its handler in a process of its own, with nothing
 * but the function's files and environment: no workspace, no node_modules of this repo.
 */
async function invoke(zip: string, handler: string, events: unknown[], env: Record<string, string> = {}): Promise<any[]> {
  const dir = mkdtempSync(join(root, 'fn-'));
  await execa('unzip', ['-q', zip, '-d', dir]);
  const [file, name] = handler.split('.') as [string, string];
  const script = `
    const mod = await import(${JSON.stringify(pathToFileURL(join(dir, `${file}.mjs`)).href)});
    const out = [];
    for (const event of JSON.parse(process.argv[1])) out.push(await mod[${JSON.stringify(name)}](event, {}));
    process.stdout.write('\\n@@result@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const run = await execa(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(events)], { cwd: dir, extendEnv: false, env: { PATH: process.env.PATH ?? '', ...env }, reject: false });
  if (run.exitCode !== 0) throw new Error(`the ${handler} handler crashed: ${run.stderr.slice(-2000)}`);
  return JSON.parse(run.stdout.slice(run.stdout.lastIndexOf('@@result@@') + '@@result@@'.length));
}

const bodyOf = (res: { body?: string; isBase64Encoded?: boolean }) => (res.isBase64Encoded ? Buffer.from(res.body ?? '', 'base64').toString() : (res.body ?? ''));

describe('the bundles of the scripted Ticket Board app', () => {
  const BASE = '/orum/ticket-board';
  let dir: string;
  let built: AppArtifacts;
  let files: string[];

  beforeAll(async () => {
    const driver = new LocalWorkspaceDriver({ root: join(root, 'workspaces'), templateDir: TEMPLATE_DIR, agent: new ScriptedAgent() });
    const workspace = await driver.open('ticket-board');
    await workspace.runAgent({ app: 'ticket-board', kind: 'build', prompt: 'A ticket board' }, () => {});
    dir = join(root, 'workspaces/ticket-board');
    built = await buildAppArtifacts(dir, { outDir: join(root, 'out'), basePath: BASE });
    files = (await execa('unzip', ['-Z1', built.web.file])).stdout.split('\n');
  }, BUILD_TIMEOUT);

  it('writes web.zip with the handler the aws deploy driver names, and leaves the workspace as it was', () => {
    expect(built.web).toMatchObject({ file: join(root, 'out/web.zip'), handler: 'index.handler' });
    expect(built.web.bytes).toBeGreaterThan(1_000_000);
    // Lambda's limit for a zip deployed from S3 is 250 MB unpacked.
    expect(built.web.bytes).toBeLessThan(50_000_000);
    expect(files).toEqual(expect.arrayContaining(['index.mjs', 'open-next.mjs']));
    expect(files.some((f) => /^assets\/_next\/static\/chunks\/.+\.js$/.test(f))).toBe(true);
    // The app's node code belongs to the node function only.
    expect(files.some((f) => f.endsWith('kelay/nodes.ts'))).toBe(false);
    for (const leftover of ['.next', '.open-next', 'open-next.config.ts']) expect(() => readFileSync(join(dir, leftover))).toThrow();
  });

  it('answers GET on the app’s path with the board page, and serves the files the page loads', async () => {
    const css = files.find((f) => /^assets\/_next\/static\/.+\.css$/.test(f))!.slice('assets'.length);
    const [page, style, missing, api, outside] = await invoke(built.web.file, built.web.handler, [
      urlEvent(BASE),
      urlEvent(`${BASE}${css}`),
      urlEvent(`${BASE}/_next/static/chunks/nope.js`),
      { ...urlEvent(`${BASE}/api/kelay/v1/apps/ticket-board/query`, 'POST'), body: '{"op":"list","collection":"tickets"}' },
      urlEvent('/'),
    ]);

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    const html = bodyOf(page);
    expect(html).toContain('<title>Ticket Board</title>');
    // Everything the browser asks for next stays under the app's path, where the Router sends it back here.
    expect(html).toContain(`href="${BASE}${css}"`);
    expect(html).not.toMatch(/(src|href)="\/_next\//);

    expect(style).toMatchObject({ statusCode: 200, isBase64Encoded: true, headers: { 'content-type': 'text/css', 'cache-control': 'public, max-age=31536000, immutable' } });
    expect(bodyOf(style)).toContain('.board');
    expect(missing.statusCode).toBe(404);
    // The data route runs in the function. This request carries no token of a signed-in person.
    expect(api.statusCode).toBe(401);
    expect(JSON.parse(bodyOf(api))).toMatchObject({ error: { code: 'unauthenticated' } });
    // Outside the app's path there is nothing: the Router never sends such a request.
    expect(outside.statusCode).toBe(404);
  }, BUILD_TIMEOUT);

  it('writes nodes.zip whose handler runs a node of the app’s graph', async () => {
    expect(built.nodes).toMatchObject({ file: join(root, 'out/nodes.zip'), handler: 'nodes.handler' });
    expect((await execa('unzip', ['-Z1', built.nodes!.file])).stdout.split('\n')).toEqual(['nodes.mjs']);

    const invocation = { runId: 'run-1', app: 'ticket-board', env: 'dev', graph: 'overdue-summary', attempt: 1, loop: 0, userToken: 'user.jwt' };
    const late = { id: 't1', title: 'Fix login', status: 'todo', due_on: '2026-11-01T00:00:00.000Z', days_overdue: 11, assignee_id: null };
    const env = { DATA_API_URL: 'http://localhost:9', KELAY_CALLER_TOKEN: 'caller.jwt' };
    // `review` joins the two branches and calls neither the Data API nor a model.
    const [approved, rejected] = await invoke(
      built.nodes!.file,
      built.nodes!.handler,
      [
        { ...invocation, node: 'review', input: [{ summary: 'One ticket is late.' }, { asOf: '2026-11-12T00:00:00.000Z', tickets: [late], priorities: [{ id: 't1', rank: 1, reason: 'oldest' }] }] },
        { ...invocation, node: 'review', input: [{ summary: 'One ticket is late.' }, { asOf: '2026-11-12T00:00:00.000Z', tickets: [late], priorities: [] }] },
      ],
      env,
    );
    expect(approved).toMatchObject({ approved: true, count: 1, tickets: [{ id: 't1', rank: 1, reason: 'oldest' }] });
    expect(rejected).toMatchObject({ approved: false, feedback: 'the ranking leaves out "Fix login"' });

    // A node the function has no code for fails under the name the graph's retry rules match on.
    await expect(invoke(built.nodes!.file, built.nodes!.handler, [{ ...invocation, node: 'nope', input: null }], env)).rejects.toThrow('Kelay.UnknownNode');
  });

  it('serves the app from the root when it is built without a base path', async () => {
    const plain = await buildAppArtifacts(dir, { outDir: join(root, 'out-root') });
    const [page] = await invoke(plain.web.file, plain.web.handler, [urlEvent('/')]);
    expect(page.statusCode).toBe(200);
    expect(bodyOf(page)).toContain('<title>Ticket Board</title>');
  }, BUILD_TIMEOUT);

  it('reports what the build printed when the app does not compile', async () => {
    const broken = join(root, 'workspaces/broken');
    await execa('cp', ['-R', dir, broken]);
    writeFileSync(join(broken, 'app/page.tsx'), `export default function Home() {\n  const n: number = 'not a number';\n  return <main>{n}</main>;\n}\n`);
    const failure = await buildAppArtifacts(broken, { outDir: join(root, 'out-broken') }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BuildError);
    expect((failure as Error).message).toContain("Type 'string' is not assignable to type 'number'");
    await expect(buildAppArtifacts(dir, { outDir: join(root, 'x'), basePath: '../etc' })).rejects.toThrow('invalid base path');
    await expect(buildAppArtifacts(join(root, 'nowhere'), { outDir: join(root, 'x') })).rejects.toThrow('no node_modules');
  }, BUILD_TIMEOUT);
});

describe('the web function entry', () => {
  const assets = join(root, 'assets');
  const app = async (event: WebEvent) => ({ statusCode: 200, body: `next:${event.rawPath}` });
  const handler = createWebHandler(app, { assetsDir: pathToFileURL(`${assets}/`), basePath: '/orum/board' });

  beforeAll(() => {
    mkdirSync(join(assets, '_next/static/chunks'), { recursive: true });
    writeFileSync(join(assets, '_next/static/chunks/app.js'), 'console.log(1)');
    writeFileSync(join(assets, 'logo.svg'), '<svg/>');
    writeFileSync(join(root, 'secret.txt'), 'outside the assets folder');
  });

  it('answers files under the base path and hands everything else to Next.js', async () => {
    const js = await handler(urlEvent('/orum/board/_next/static/chunks/app.js'));
    expect(js).toEqual({ statusCode: 200, headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable', 'content-length': '14' }, body: Buffer.from('console.log(1)').toString('base64'), isBase64Encoded: true });
    expect((await handler(urlEvent('/orum/board/logo.svg'))).headers).toMatchObject({ 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=0, must-revalidate' });
    expect(await handler(urlEvent('/orum/board/logo.svg', 'HEAD'))).toMatchObject({ statusCode: 200, headers: { 'content-length': '6' } });
    expect((await handler(urlEvent('/orum/board/logo.svg', 'HEAD'))).body).toBeUndefined();

    for (const path of ['/orum/board', '/orum/board/', '/orum/board/tickets/1', '/orum/board/_next/static/chunks/missing.js', '/logo.svg', '/orum/board/_next/static']) {
      expect(await handler(urlEvent(path)), path).toEqual({ statusCode: 200, body: `next:${path}` });
    }
    expect(await handler(urlEvent('/orum/board/logo.svg', 'POST'))).toEqual({ statusCode: 200, body: 'next:/orum/board/logo.svg' });
  });

  it('never reads outside the assets folder', async () => {
    for (const path of ['/orum/board/../secret.txt', '/orum/board/%2e%2e/secret.txt', '/orum/board/..%2fsecret.txt', '/orum/board/_next/../../secret.txt', '/orum/board/%00', '/orum/board/%zz']) {
      expect((await handler(urlEvent(path))).body, path).toBe(`next:${path}`);
    }
  });
});

describe('artifact stores', () => {
  const zip = join(root, 'some.zip');
  beforeAll(() => writeFileSync(zip, 'zip bytes'));

  it('keeps bundles in a folder and names them by file URL', async () => {
    const store = new LocalArtifactStore(join(root, 'store'));
    const url = await store.put(artifactKey('team-board', 'abc123', 'web.zip'), zip);
    expect(url).toBe(pathToFileURL(join(root, 'store/builds/team-board/abc123/web.zip')).toString());
    expect(readFileSync(fileURLToPath(url), 'utf8')).toBe('zip bytes');
    for (const key of ['../escape.zip', '/abs.zip', 'builds//x.zip', 'builds/./x.zip', 'a b.zip', '']) await expect(store.put(key, zip), key).rejects.toThrow('invalid artifact key');
  });

  it('puts bundles in the artifacts bucket under builds/, where the Deploy role reads them', async () => {
    const s3 = mockClient(S3Client);
    let uploaded = '';
    s3.on(PutObjectCommand).callsFake(async (input: { Body: Readable }) => {
      for await (const chunk of input.Body) uploaded += String(chunk);
      return {};
    });
    const store = new S3ArtifactStore({ bucket: 'kelay-staging-artifacts-111111111111', client: new S3Client({ region: 'ap-northeast-2' }) });
    expect(await store.put(artifactKey('team-board', 'abc123', 'nodes.zip'), zip)).toBe('s3://kelay-staging-artifacts-111111111111/builds/team-board/abc123/nodes.zip');
    const input = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ Bucket: 'kelay-staging-artifacts-111111111111', Key: 'builds/team-board/abc123/nodes.zip', ContentLength: 9, ContentType: 'application/zip' });
    expect(uploaded).toBe('zip bytes');
    await expect(store.put('../x.zip', zip)).rejects.toThrow('invalid artifact key');
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);
    s3.restore();
  });

  it('is chosen by BUILDER_ARTIFACT_STORE', () => {
    expect(artifactStoreFromEnv({}, '/tmp/a')).toBeNull();
    expect(artifactStoreFromEnv({ BUILDER_ARTIFACT_STORE: 'local' }, join(root, 'default'))?.name).toBe('local');
    expect(artifactStoreFromEnv({ BUILDER_ARTIFACT_STORE: 's3', BUILDER_ARTIFACTS_BUCKET: 'b', AWS_REGION: 'ap-northeast-2' }, '/tmp/a')?.name).toBe('s3');
    expect(() => artifactStoreFromEnv({ BUILDER_ARTIFACT_STORE: 's3' }, '/tmp/a')).toThrow('BUILDER_ARTIFACTS_BUCKET');
    expect(() => artifactStoreFromEnv({ BUILDER_ARTIFACT_STORE: 'gcs' }, '/tmp/a')).toThrow('must be local or s3');
  });
});
