// A workspace in another process. Inside a Fargate task the image runs `createRuntimeApp` over a local
// workspace (src/runtime-server.ts); the Builder service talks to it through `RemoteWorkspace`. The task
// holds the repo, the coding agent and `next dev`, and no platform secret: checks and deploys stay here.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { AgentError, type AgentEvent, type AgentResult, type AgentTurn } from '../agents/types.ts';
import { BuildError, type AppArtifacts, type BuiltArtifact } from '../artifacts/build.ts';
import type { AgentInfo } from '../events.ts';
import { ManifestError, type CommitInfo, type Workspace } from './types.ts';

export const RUNTIME_TOKEN_HEADER = 'x-kelay-runtime-token';

type AgentLine = { event: AgentEvent } | { result: AgentResult } | { error: string };

const ARTIFACTS = ['web', 'nodes'] as const;
/** What a build reports over the wire: the files themselves are fetched from /runtime/artifacts. */
type BuiltReport = Record<(typeof ARTIFACTS)[number], Omit<BuiltArtifact, 'file'> | null>;

export function createRuntimeApp(workspace: Workspace, token: string): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true, service: 'builder-runtime', app: workspace.app }));
  app.use('/runtime/*', async (c, next) => {
    if (c.req.header(RUNTIME_TOKEN_HEADER) !== token) return c.json({ error: 'wrong runtime token' }, 403);
    await next();
  });
  app.onError((e, c) => c.json({ error: e.message, manifest: e instanceof ManifestError, build: e instanceof BuildError }, 500));

  app.get('/runtime/info', async (c) => c.json({ app: workspace.app, created: workspace.created, agent: workspace.agent, previewing: workspace.previewTarget() !== null }));
  app.get('/runtime/head', async (c) => c.json(await workspace.head()));
  app.get('/runtime/manifest', async (c) => c.json({ manifest: await workspace.manifest() }));
  app.post('/runtime/commit', async (c) => c.json({ commit: await workspace.commit((await c.req.json<{ message: string }>()).message) }));
  app.post('/runtime/checkout', async (c) => {
    await workspace.checkout((await c.req.json<{ branch: string }>()).branch);
    return c.json({ ok: true });
  });
  app.post('/runtime/merge', async (c) => {
    const { branch, into } = await c.req.json<{ branch: string; into: string }>();
    await workspace.merge(branch, into);
    return c.json({ ok: true });
  });
  // The bundles stay in the task until the Builder has fetched them: the task may not write to the artifact store.
  let artifactsDir: Promise<string> | null = null;
  app.post('/runtime/build', async (c) => {
    const { basePath } = await c.req.json<{ basePath: string }>();
    artifactsDir ??= mkdtemp(join(tmpdir(), 'kelay-artifacts-'));
    const built = await workspace.build({ outDir: await artifactsDir, basePath });
    const report = ({ file: _file, ...rest }: BuiltArtifact) => rest;
    return c.json({ web: report(built.web), nodes: built.nodes ? report(built.nodes) : null } satisfies BuiltReport);
  });
  app.get('/runtime/artifacts/:name', async (c) => {
    const name = ARTIFACTS.find((a) => `${a}.zip` === c.req.param('name'));
    if (!name || !artifactsDir) return c.json({ error: 'no such artifact' }, 404);
    const file = join(await artifactsDir, `${name}.zip`);
    const info = await stat(file).catch(() => null);
    if (!info) return c.json({ error: 'no such artifact' }, 404);
    return new Response(Readable.toWeb(createReadStream(file)) as unknown as ReadableStream, { headers: { 'content-type': 'application/zip', 'content-length': String(info.size) } });
  });

  app.post('/runtime/preview', async (c) => c.json({ url: await workspace.startPreview((await c.req.json<{ env: Record<string, string> }>()).env) }));
  app.post('/runtime/stop', async (c) => {
    await workspace.stop();
    return c.json({ ok: true });
  });

  // One JSON object per line: the agent's events as they happen, then its result or the error.
  app.post('/runtime/agent', async (c) => {
    const turn = await c.req.json<Omit<AgentTurn, 'dir' | 'signal'>>();
    c.header('content-type', 'application/x-ndjson');
    return stream(c, async (out) => {
      const write = (line: AgentLine) => out.write(`${JSON.stringify(line)}\n`);
      const abort = new AbortController();
      out.onAbort(() => abort.abort());
      try {
        const result = await workspace.runAgent({ ...turn, signal: abort.signal }, (event) => void write({ event }));
        await write({ result });
      } catch (e) {
        await write({ error: (e as Error).message });
      }
    });
  });
  return app;
}

export interface RemoteWorkspaceOptions {
  app: string;
  ref: string;
  /** Base URL of the runtime in the task, e.g. http://10.0.3.17:4007. */
  endpoint: string;
  token: string;
  /** Where the task's `next dev` listens, as the Builder reaches it, e.g. http://10.0.3.17:3000. */
  previewTarget: string;
  stop: () => Promise<void>;
  fetch?: typeof fetch;
}

export class RemoteWorkspace implements Workspace {
  readonly app: string;
  readonly ref: string;
  created = false;
  agent: AgentInfo = { kind: 'scripted', model: null };
  private previewing = false;
  private readonly fetch_: typeof fetch;

  constructor(private readonly opts: RemoteWorkspaceOptions) {
    this.app = opts.app;
    this.ref = opts.ref;
    this.fetch_ = opts.fetch ?? fetch;
  }

  /** Reads what the task reports about itself; call once after the task is up. */
  async connect(): Promise<this> {
    const info = await this.call<{ created: boolean; agent: AgentInfo; previewing: boolean }>('GET', '/runtime/info');
    this.created = info.created;
    this.agent = info.agent;
    this.previewing = info.previewing;
    return this;
  }

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await this.fetch_(`${this.opts.endpoint}${path}`, {
      method,
      headers: { [RUNTIME_TOKEN_HEADER]: this.opts.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const failure = (await res.json().catch(() => null)) as { error?: string; manifest?: boolean; build?: boolean } | null;
      const message = failure?.error ?? `workspace runtime answered ${res.status}`;
      throw failure?.manifest ? new ManifestError(message) : failure?.build ? new BuildError(message) : new Error(message);
    }
    return res;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.request(method, path, body)).json()) as T;
  }

  async runAgent(turn: Omit<AgentTurn, 'dir'>, emit: (event: AgentEvent) => void): Promise<AgentResult> {
    const { signal, ...rest } = turn;
    const res = await this.request('POST', '/runtime/agent', rest, signal);
    const decoder = new TextDecoder();
    let buffer = '';
    let result: AgentResult | undefined;
    const take = (line: string) => {
      if (!line.trim()) return;
      const parsed = JSON.parse(line) as AgentLine;
      if ('event' in parsed) emit(parsed.event);
      else if ('result' in parsed) result = parsed.result;
      else throw new AgentError(parsed.error);
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(take);
    }
    take(buffer);
    if (!result) throw new AgentError('the workspace ended the turn without a result');
    return result;
  }

  async commit(message: string) {
    return (await this.call<{ commit: CommitInfo | null }>('POST', '/runtime/commit', { message })).commit;
  }

  head() {
    return this.call<{ commit: string; message: string; branch: string }>('GET', '/runtime/head');
  }

  async checkout(branch: string) {
    await this.call('POST', '/runtime/checkout', { branch });
  }

  async merge(branch: string, into: string) {
    await this.call('POST', '/runtime/merge', { branch, into });
  }

  async manifest() {
    return (await this.call<{ manifest: unknown }>('GET', '/runtime/manifest')).manifest;
  }

  async build(opts: { outDir: string; basePath: string }): Promise<AppArtifacts> {
    const report = await this.call<BuiltReport>('POST', '/runtime/build', { basePath: opts.basePath });
    await mkdir(opts.outDir, { recursive: true });
    const fetched = async (name: (typeof ARTIFACTS)[number]): Promise<BuiltArtifact | null> => {
      const built = report[name];
      if (!built) return null;
      const file = join(opts.outDir, `${name}.zip`);
      const res = await this.request('GET', `/runtime/artifacts/${name}.zip`);
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(file));
      const { size } = await stat(file);
      if (size !== built.bytes) throw new Error(`${name}.zip arrived with ${size} bytes, the workspace built ${built.bytes}`);
      return { ...built, file };
    };
    const web = await fetched('web');
    if (!web) throw new Error('the workspace built no web bundle');
    return { web, nodes: await fetched('nodes') };
  }

  async startPreview(env: Record<string, string>) {
    await this.call('POST', '/runtime/preview', { env });
    this.previewing = true;
    return this.opts.previewTarget;
  }

  previewTarget() {
    return this.previewing ? this.opts.previewTarget : null;
  }

  async stop() {
    this.previewing = false;
    await this.opts.stop();
  }
}
