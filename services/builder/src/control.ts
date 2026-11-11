// The Builder's calls to the Control API. Reads on behalf of a builder carry that builder's own token,
// so the Control API decides ownership. Everything else is a platform service call (contracts §4).
import { CALLER_HEADER, type AppSchema, type PolicyMatrix } from '@kelay/contracts';
import { signCallerToken } from '@kelay/tokens';
import { ApiError, type BuilderErrorCode } from './errors.ts';

export interface AppInfo {
  slug: string;
  handle: string;
  name: string;
  owner: string;
  /** Whether a version is already deployed to Development. */
  deployedToDev: boolean;
}

export interface DeployRequest {
  commit: string;
  artifactUrl: string;
  configVersion: string;
  schema: AppSchema;
  policy: PolicyMatrix;
  graphs: { name: string; definition: string }[];
}

export interface DeployedVersion {
  id: string;
  label: string;
  /** The app-runtime caller token, returned by the local deploy driver only. */
  callerToken: string | null;
}

export interface ImprovementJob {
  run: { id: string; app: string; proposalId: string };
  proposal: { id: string; title: string; body: string; refs: string[]; affects: string };
}

export interface RunOutcome {
  status: 'succeeded' | 'failed';
  branch?: string;
  versionId?: string;
  error?: string;
}

export interface SandboxRecord {
  taskArn: string;
  owner: string;
  app: string;
  kind: 'workspace' | 'improvement';
  status: 'running' | 'stopped';
}

export interface ControlApi {
  /** The app as its owner sees it. Rejects with the Control API's own error (`denied`, `unknown_app`, `unauthenticated`). */
  appFor(builderToken: string, app: string): Promise<AppInfo>;
  setDatabase(app: string, env: 'dev' | 'prod', databaseUrl: string): Promise<void>;
  deploy(app: string, env: 'dev', request: DeployRequest): Promise<DeployedVersion>;
  claimImprovement(worker: string): Promise<ImprovementJob | null>;
  completeImprovement(runId: string, outcome: RunOutcome): Promise<void>;
  recordSandbox(record: SandboxRecord): Promise<void>;
}

export interface ControlClientOptions {
  baseUrl: string;
  callerSecret: string;
  fetch?: typeof fetch;
}

type Json = Record<string, any>;

export class ControlClient implements ControlApi {
  private readonly fetch_: typeof fetch;

  constructor(private readonly opts: ControlClientOptions) {
    this.fetch_ = opts.fetch ?? fetch;
  }

  private async request(method: string, path: string, auth: { builderToken: string } | 'service', body?: unknown): Promise<Json | null> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (auth === 'service') headers[CALLER_HEADER] = await signCallerToken({ kind: 'service', svc: 'builder' }, this.opts.callerSecret);
    else headers.authorization = `Bearer ${auth.builderToken}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetch_(new URL(path, this.opts.baseUrl), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (e) {
      throw new ApiError('internal', `the Control API could not be reached: ${(e as Error).message}`);
    }
    if (res.status === 204) return null;
    const json = (await res.json().catch(() => null)) as Json | null;
    if (!res.ok) {
      const code = (json?.error?.code as BuilderErrorCode | undefined) ?? 'internal';
      throw new ApiError(code, json?.error?.message ?? `${method} ${path} failed (${res.status})`);
    }
    return json;
  }

  async appFor(builderToken: string, app: string): Promise<AppInfo> {
    const body = (await this.request('GET', `/v1/apps/${encodeURIComponent(app)}`, { builderToken }))!;
    const dev = (body.envs as Json[] | undefined)?.find((e) => e.name === 'dev');
    return { slug: body.app.slug, handle: body.app.handle, name: body.app.name, owner: body.app.owner, deployedToDev: dev?.activeVersion != null };
  }

  async setDatabase(app: string, env: 'dev' | 'prod', databaseUrl: string): Promise<void> {
    await this.request('PUT', `/internal/v1/apps/${encodeURIComponent(app)}/envs/${env}`, 'service', { databaseUrl });
  }

  async deploy(app: string, env: 'dev', request: DeployRequest): Promise<DeployedVersion> {
    const body = (await this.request('POST', `/v1/apps/${encodeURIComponent(app)}/envs/${env}/deploy`, 'service', request))!;
    return { id: body.version.id, label: body.version.label, callerToken: body.callerToken ?? null };
  }

  async claimImprovement(worker: string): Promise<ImprovementJob | null> {
    const body = await this.request('POST', '/internal/v1/improvement-runs/claim', 'service', { worker });
    if (!body?.run) return null;
    const p = (body.proposal ?? {}) as Json;
    return {
      run: { id: body.run.id, app: body.run.app, proposalId: body.run.proposalId },
      proposal: { id: p.id ?? body.run.proposalId, title: p.title ?? '', body: p.body ?? '', refs: Array.isArray(p.refs) ? p.refs : [], affects: p.affects ?? '' },
    };
  }

  async completeImprovement(runId: string, outcome: RunOutcome): Promise<void> {
    await this.request('POST', `/internal/v1/improvement-runs/${encodeURIComponent(runId)}/complete`, 'service', outcome);
  }

  async recordSandbox(record: SandboxRecord): Promise<void> {
    await this.request('PUT', '/internal/v1/sandboxes', 'service', record);
  }
}
