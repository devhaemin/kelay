import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audienceForApp } from '@kelay/contracts';
import { createDevSigner, type DevSigner } from '@kelay/tokens';
import { CONSOLE_APP, createBuilderApi } from '../src/app.ts';
import { ScriptedAgent } from '../src/agents/scripted.ts';
import type { CodingAgent } from '../src/agents/types.ts';
import type { ArtifactStore } from '../src/artifacts/store.ts';
import type { AppInfo, ControlApi, DeployRequest, DeployedVersion, ImprovementJob, RunOutcome, SandboxRecord } from '../src/control.ts';
import { LocalWorkspaceDriver, type PreviewLauncher } from '../src/drivers/local.ts';
import { ApiError } from '../src/errors.ts';
import type { WorkspaceEvent } from '../src/events.ts';
import { createLogger } from '../src/log.ts';
import { WorkspaceManager } from '../src/workspaces.ts';

/** The real starter template with its installed toolchain, so `kelay/manifest.ts` really runs. */
export const TEMPLATE_DIR = fileURLToPath(new URL('../../../templates/starter', import.meta.url));

/** The Control API as the Builder sees it, in memory. */
export class FakeControl implements ControlApi {
  apps = new Map<string, AppInfo>();
  deploys: { app: string; env: string; request: DeployRequest }[] = [];
  databases: { app: string; env: string; url: string }[] = [];
  sandboxes: SandboxRecord[] = [];
  queue: ImprovementJob[] = [];
  completed: { runId: string; outcome: RunOutcome }[] = [];
  failDeploy: string | null = null;

  addApp(slug: string, owner: string, extra: Partial<AppInfo> = {}) {
    this.apps.set(slug, { slug, handle: 'orum', name: slug, owner, deployedToDev: false, ...extra });
  }

  async appFor(builderToken: string, app: string): Promise<AppInfo> {
    const info = this.apps.get(app);
    if (!info) throw new ApiError('unknown_app', `unknown app ${app}`);
    // Tokens in these tests are signed for a `sub`; the fake reads it back the way the Control API would after verifying.
    const sub = JSON.parse(Buffer.from(builderToken.split('.')[1]!, 'base64url').toString()).sub;
    if (info.owner !== sub) throw new ApiError('denied', 'you do not own this app');
    return info;
  }

  async setDatabase(app: string, env: 'dev' | 'prod', url: string) {
    this.databases.push({ app, env, url });
  }

  async deploy(app: string, env: 'dev', request: DeployRequest): Promise<DeployedVersion> {
    if (this.failDeploy) throw new ApiError('internal', this.failDeploy);
    this.deploys.push({ app, env, request });
    const n = this.deploys.filter((d) => d.app === app).length;
    return { id: `00000000-0000-4000-8000-00000000000${n}`, label: `v${n}`, callerToken: `caller-token-${n}` };
  }

  async claimImprovement() {
    return this.queue.shift() ?? null;
  }

  async completeImprovement(runId: string, outcome: RunOutcome) {
    this.completed.push({ runId, outcome });
  }

  async recordSandbox(record: SandboxRecord) {
    this.sandboxes.push(record);
  }
}

export interface Harness {
  root: string;
  control: FakeControl;
  workspaces: WorkspaceManager;
  driver: LocalWorkspaceDriver;
  signer: DevSigner;
  previews: { dir: string; env: Record<string, string>; stopped: boolean }[];
  api: ReturnType<typeof createBuilderApi>;
  token(sub: string, role?: string): Promise<string>;
  req(method: string, path: string, opts?: { token?: string; body?: unknown }): Promise<{ status: number; body: any }>;
  /** Waits until the workspace's current turn has finished and returns the whole transcript. */
  settled(app: string): Promise<WorkspaceEvent[]>;
  dir(app: string): string;
  close(): Promise<void>;
}

export async function createHarness(opts: { agent?: CodingAgent; artifacts?: ArtifactStore } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'kelay-builder-'));
  const control = new FakeControl();
  const signer = await createDevSigner();
  const previews: Harness['previews'] = [];
  const preview: PreviewLauncher = async ({ dir, env }) => {
    const record = { dir, env, stopped: false };
    previews.push(record);
    return { url: `http://localhost:39${String(previews.length).padStart(3, '0')}`, stop: async () => void (record.stopped = true) };
  };
  const agent = opts.agent ?? new ScriptedAgent();
  const driver = new LocalWorkspaceDriver({ root: join(root, 'workspaces'), templateDir: TEMPLATE_DIR, agent, preview });
  const logger = createLogger('silent');
  const workspaces = new WorkspaceManager({
    driver,
    control,
    agent: agent.info,
    stateDir: join(root, 'state'),
    logger,
    runtimeEnv: { DATA_API_URL: 'http://localhost:4002', CONTROL_API_URL: 'http://localhost:4003' },
    provisioner: { ensure: async (app, env) => `postgres://test/app_${app.replaceAll('-', '_')}_${env}` },
    ...(opts.artifacts ? { artifacts: opts.artifacts } : {}),
    idleMs: 0,
  });
  const api = createBuilderApi({ auth: { issuer: signer.issuer, jwks: signer.verifier }, control, workspaces, logger });

  const h: Harness = {
    root,
    control,
    workspaces,
    driver,
    signer,
    previews,
    api,
    token: (sub, role = 'builder') => signer.sign({ sub, app: CONSOLE_APP, aud: audienceForApp(CONSOLE_APP), org: 'orum', role, plan: 'pro' }),
    async req(method, path, o = {}) {
      const headers: Record<string, string> = {};
      if (o.token) headers.authorization = `Bearer ${o.token}`;
      if (o.body !== undefined) headers['content-type'] = 'application/json';
      const res = await api.request(path, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async settled(app) {
      const log = workspaces.events(app);
      for (let i = 0; i < 3600; i++) {
        if ((await workspaces.status(app))?.state !== 'working' && log.last?.type === 'turn.finished') return log.since(0);
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`the turn of ${app} did not finish: ${JSON.stringify(log.since(0).map((e) => e.type))}`);
    },
    dir: (app) => join(root, 'workspaces', app),
    async close() {
      await workspaces.shutdown();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}
