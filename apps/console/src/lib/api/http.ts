// ConsoleApi over the Control API (services/control-api). Responses are mapped from the Control
// API's views (slug, purpose, fromApp, ...) to the console's types. Reads the Control API has no
// route for yet are marked PROVISIONAL: a 404 means "not available" and yields null.
import { AppSchema, PolicyMatrix } from '@kelay/contracts';
import { ApiError, isApiError } from './errors';
import type {
  AppDetail,
  AppMetrics,
  AppSummary,
  AssistantKind,
  Builder,
  ChatMessage,
  ConsoleApi,
  Consent,
  DeployResult,
  Env,
  FeedbackTicket,
  Grant,
  GraphOverview,
  ImprovementReport,
  Member,
  Proposal,
  ProposalDecision,
  QaSummary,
  ToolCall,
} from './types';

export interface HttpApiOptions {
  baseUrl: string;
  token: string;
  /** Origin public app URLs are served from (`/<handle>/<app>`). */
  appOrigin?: string;
  /** MCP_PUBLIC_BASE_URL of the MCP gateway (contracts §7). */
  mcpBaseUrl?: string;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

const STATUS_CODES: Record<number, string> = { 400: 'invalid_request', 401: 'unauthenticated', 403: 'denied', 404: 'not_found', 409: 'conflict', 429: 'rate_limited' };
const REPORTS_WITH_PROPOSALS = 5;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);
const obj = (v: unknown): Json => (isObject(v) ? v : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObject) : []);

const unavailable = (what: string) => new ApiError('unavailable', `${what} isn’t available from the Control API yet`, 501);

const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(?![a-z])/, 'app-').slice(0, 48) || 'app';

/** A display name from the first words of a build prompt. */
function nameFromPrompt(prompt: string): string {
  const words = prompt.replace(/^(an?|the)\s+/i, '').split(/[\s,:.;]+/).filter(Boolean).slice(0, 3);
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return name || 'Untitled app';
}

const assistantKind = (name: string, clientId: string): AssistantKind => {
  const s = `${name} ${clientId}`.toLowerCase();
  return s.includes('claude') ? 'claude' : s.includes('cursor') ? 'cursor' : 'other';
};

export function createHttpApi({ baseUrl, token, appOrigin = 'https://kelay.app', mcpBaseUrl = appOrigin, fetch: fetchImpl = fetch }: HttpApiOptions): ConsoleApi {
  async function request(method: string, path: string, body?: unknown): Promise<Json> {
    const res = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    if (res.status === 204) return {};
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = obj(obj(json).error);
      throw new ApiError(str(err.code, STATUS_CODES[res.status] ?? 'internal'), str(err.message, `${method} ${path} failed (${res.status})`), res.status);
    }
    return obj(json);
  }

  async function optional(p: Promise<Json>): Promise<Json | null> {
    try {
      return await p;
    } catch (e) {
      if (isApiError(e) && e.status === 404) return null;
      throw e;
    }
  }

  const seg = encodeURIComponent;

  function toSummary(raw: Json): AppSummary {
    const id = str(raw.slug) || str(raw.id);
    return {
      id,
      handle: str(raw.handle),
      name: str(raw.name, id),
      emoji: str(raw.emoji) || '✨',
      color: str(raw.color) || '#eef1ff',
      description: str(raw.description),
      status: oneOf(raw.status, ['live', 'draft', 'paused'] as const, 'draft'),
      users: num(raw.members),
      runs: typeof raw.runs === 'number' ? raw.runs : null,
      newFeedback: num(raw.newFeedback),
      updatedAt: str(raw.updatedAt) || new Date(0).toISOString(),
    };
  }

  interface EnvView {
    name: Env;
    active: { id: string; label: string; number: number; commit: string; artifactUrl: string; configVersion: string } | null;
  }

  const toEnvs = (raw: unknown): EnvView[] =>
    arr(raw).map((e) => {
      const v = isObject(e.activeVersion) ? e.activeVersion : null;
      return {
        name: e.name === 'prod' ? 'prod' : 'dev',
        active: v
          ? { id: str(v.id), label: str(v.label, `v${num(v.number)}`), number: num(v.number), commit: str(v.commit), artifactUrl: str(v.artifactUrl), configVersion: str(v.configVersion) }
          : null,
      };
    });

  async function getAppWithEnvs(app: string): Promise<{ detail: AppDetail; envs: EnvView[]; raw: Json }> {
    const body = await request('GET', `/v1/apps/${seg(app)}`);
    const raw = obj(body.app);
    const s = toSummary(raw);
    const envs = toEnvs(body.envs);
    const dev = envs.find((e) => e.name === 'dev')?.active ?? null;
    const prod = envs.find((e) => e.name === 'prod')?.active ?? null;
    const ahead = dev && (!prod || dev.number > prod.number);
    const path = str(raw.path, `/${s.handle}/${s.id}`);
    return {
      raw: body,
      envs,
      detail: {
        ...s,
        productionUrl: `${appOrigin}${path}`,
        mcpEndpoint: `${mcpBaseUrl}${path}/mcp`,
        previewUrl: null,
        version: prod?.label ?? null,
        pendingChange: ahead ? { title: `Development has ${dev.label}${prod ? `, production runs ${prod.label}` : ', not published yet'}`, count: dev.number - (prod?.number ?? 0) } : null,
      },
    };
  }

  // app_members rows (contracts §9); the Control API returns them as stored, without profile fields.
  function toMember(raw: Json): Member {
    const userId = str(raw.userId) || str(raw.user_id);
    return {
      userId,
      name: str(raw.name) || str(raw.email) || userId,
      email: str(raw.email),
      role: str(raw.role, 'member'),
      plan: str(raw.plan, 'free'),
      status: oneOf(raw.status, ['active', 'unconfirmed', 'banned'] as const, 'active'),
      provider: oneOf(raw.provider, ['google', 'email', 'kakao', 'github'] as const, 'email'),
      createdAt: str(raw.createdAt) || str(raw.created_at) || new Date(0).toISOString(),
      lastSignInAt: str(raw.lastSignInAt) || null,
      assistant: str(raw.assistant) || null,
      otherApps: [],
    };
  }

  function toTicket(raw: Json): FeedbackTicket {
    return {
      id: str(raw.id),
      key: str(raw.key),
      app: str(raw.app),
      status: oneOf(raw.status, ['new', 'triaged', 'progress', 'done'] as const, 'new'),
      type: oneOf(raw.type, ['bug', 'ux', 'feat', 'quality'] as const, 'feat'),
      title: str(raw.title),
      quote: `“${str(raw.text)}”`,
      votes: num(raw.votes, 1),
      priority: oneOf(raw.priority, ['high', 'med', 'low'] as const, 'low'),
      reporterId: str(raw.reporter),
      replies: num(raw.replies),
      fixedIn: str(raw.fixedIn) || null,
    };
  }

  function toProposal(raw: Json): Proposal {
    const status = str(raw.status);
    return {
      id: str(raw.id),
      reportId: str(raw.reportId),
      title: str(raw.title),
      body: str(raw.body),
      refs: Array.isArray(raw.refs) ? raw.refs.filter((r): r is string => typeof r === 'string') : [],
      impact: oneOf(raw.impact, ['High', 'Med', 'Low'] as const, 'Med'),
      effort: oneOf(raw.effort, ['S', 'M', 'L'] as const, 'M'),
      affects: str(raw.affects),
      grantId: null,
      state: status === 'built' ? 'approved' : oneOf(status, ['pending', 'approved', 'rejected'] as const, 'pending'),
    };
  }

  function toReport(report: Json, proposals: Json[]): ImprovementReport {
    const stats = obj(report.stats);
    return {
      id: str(report.id),
      app: str(report.app),
      createdAt: str(report.createdAt) || str(report.date),
      author: 'Self-Improvement Agent',
      messages: num(stats.received),
      valid: num(stats.valid),
      summary: str(report.summary),
      proposals: proposals.map(toProposal),
    };
  }

  function toGrant(raw: Json): Grant {
    return {
      id: str(raw.id),
      from: str(raw.fromApp),
      to: str(raw.toApp),
      kind: raw.kind === 'A2A' ? 'A2A' : 'MCP',
      what: str(raw.purpose),
      status: oneOf(raw.status, ['pending', 'connected', 'rejected'] as const, 'pending'),
      callsPerDay: num(raw.calls),
      since: str(raw.decidedAt) || str(raw.createdAt),
      proposalId: null,
    };
  }

  function toConsent(raw: Json): Consent {
    const clientId = str(raw.clientId);
    const name = str(raw.clientName) || clientId;
    return {
      id: str(raw.id),
      app: str(raw.app),
      userId: str(raw.userId),
      client: { id: clientId, name, kind: assistantKind(name, clientId) },
      scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((s): s is string => typeof s === 'string') : [],
      grantedAt: str(raw.createdAt),
      lastUsedAt: str(raw.lastUsedAt) || null,
    };
  }

  async function deployVersion(app: string, env: Env, source: EnvView['active'], url: string): Promise<DeployResult> {
    if (!source) throw new ApiError('invalid_request', 'Nothing to deploy yet: the Builder workspace has not produced a build.', 400);
    const started = Date.now();
    const body = await request('POST', `/v1/apps/${seg(app)}/envs/${env}/deploy`, {
      commit: source.commit,
      artifactUrl: source.artifactUrl,
      configVersion: source.configVersion,
    });
    const v = obj(body.version);
    return { app, env, version: str(v.label, source.label), status: 'live', url, durationMs: Date.now() - started };
  }

  const api: ConsoleApi = {
    mode: 'http',

    async getMe() {
      const me = await optional(request('GET', '/v1/me')); // PROVISIONAL
      if (me) {
        const b = obj(me.builder ?? me);
        return { name: str(b.name) || str(b.handle), handle: str(b.handle), email: str(b.email), team: str(b.team) } satisfies Builder;
      }
      const apps = await api.listApps();
      const handle = apps[0]?.handle ?? 'me';
      return { name: handle, handle, email: '', team: '' };
    },

    async listApps() {
      return arr((await request('GET', '/v1/apps')).apps).map(toSummary);
    },

    async getApp(app) {
      return (await getAppWithEnvs(app)).detail;
    },

    async createApp({ prompt }) {
      const name = nameFromPrompt(prompt);
      const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
      const body = await request('POST', '/v1/apps', { slug, name, description: prompt.slice(0, 2000) });
      return toSummary(obj(body.app));
    },

    async getPreview(app) {
      const a = await api.getApp(app);
      return a.previewUrl ? { kind: 'url', url: a.previewUrl } : null;
    },

    async listMembers(app) {
      return arr((await request('GET', `/v1/apps/${seg(app)}/members`)).members).map(toMember);
    },

    async updateMember(app, userId, patch) {
      if (patch.status === 'unconfirmed') throw new ApiError('invalid_request', 'A member can only be banned or made active', 400);
      return toMember(obj((await request('PATCH', `/v1/apps/${seg(app)}/members/${seg(userId)}`, patch)).member));
    },

    async removeMember(app, userId) {
      await request('DELETE', `/v1/apps/${seg(app)}/members/${seg(userId)}`);
    },

    async sendPasswordRecovery() {
      throw unavailable('Password recovery email');
    },

    async listTickets(app) {
      return arr((await request('GET', `/v1/apps/${seg(app)}/tickets`)).tickets).map(toTicket);
    },

    async updateTicket(app, key, patch) {
      return toTicket(obj((await request('PATCH', `/v1/apps/${seg(app)}/tickets/${seg(key)}`, patch)).ticket));
    },

    async listReports(app) {
      const reports = arr((await request('GET', `/v1/apps/${seg(app)}/reports?limit=${REPORTS_WITH_PROPOSALS}`)).reports);
      const full = await Promise.all(
        reports.map(async (r) => {
          const body = await request('GET', `/v1/apps/${seg(app)}/reports/${seg(str(r.id))}`);
          return toReport(obj(body.report), arr(body.proposals));
        }),
      );
      return full.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async runReport(app) {
      const body = await request('POST', `/v1/apps/${seg(app)}/reports/run`, {});
      return toReport(obj(body.report), arr(body.proposals));
    },

    async approveProposal(id) {
      return { proposal: toProposal(obj((await request('POST', `/v1/proposals/${seg(id)}/approve`)).proposal)), grant: null } satisfies ProposalDecision;
    },

    async rejectProposal(id) {
      return { proposal: toProposal(obj((await request('POST', `/v1/proposals/${seg(id)}/reject`)).proposal)), grant: null } satisfies ProposalDecision;
    },

    async reopenProposal() {
      throw unavailable('Undoing a proposal decision');
    },

    async listGrants() {
      return arr((await request('GET', '/v1/grants')).grants).map(toGrant).filter((g) => g.status !== 'rejected');
    },

    async requestGrant(input) {
      if (input.from === 'agents') throw new ApiError('invalid_request', 'Personal agents connect through each member’s consent, not a grant', 400);
      return toGrant(obj((await request('POST', '/v1/grants', { fromApp: input.from, toApp: input.to, kind: input.kind, purpose: input.what })).grant));
    },

    async allowGrant(id) {
      return toGrant(obj((await request('POST', `/v1/grants/${seg(id)}/allow`)).grant));
    },

    async rejectGrant(id) {
      return toGrant(obj((await request('POST', `/v1/grants/${seg(id)}/reject`)).grant));
    },

    async getGraphOverview() {
      const body = await optional(request('GET', '/v1/graph/overview')); // PROVISIONAL
      return body ? (obj(body.overview ?? body) as unknown as GraphOverview) : null;
    },

    async listConsents(app) {
      const body = app ? await request('GET', `/v1/apps/${seg(app)}/consents`) : await request('GET', '/v1/me/consents');
      return arr(body.consents).map(toConsent);
    },

    async revokeConsent(id) {
      // Revocation is the consenting user's call; a builder can only end their own consents.
      await request('POST', `/v1/me/consents/${seg(id)}/revoke`);
    },

    async listToolCalls(app) {
      const body = await optional(request('GET', `/v1/apps/${seg(app)}/tool-calls`)); // PROVISIONAL
      return body ? (arr(body.toolCalls) as unknown as ToolCall[]) : null;
    },

    async deploy(app, env) {
      const { envs, detail } = await getAppWithEnvs(app);
      const source = envs.find((e) => e.name === env)?.active ?? envs.find((e) => e.name === 'dev')?.active ?? null;
      return deployVersion(app, env, source, detail.productionUrl);
    },

    async publish(app) {
      const { envs } = await getAppWithEnvs(app);
      const dev = envs.find((e) => e.name === 'dev')?.active;
      if (!dev) throw new ApiError('invalid_request', 'Nothing to publish yet: deploy a version to Development first.', 400);
      const started = Date.now();
      const body = await request('POST', `/v1/apps/${seg(app)}/publish`, { versionId: dev.id });
      const a = obj(body.app);
      return {
        app,
        env: 'prod',
        version: str(obj(body.version).label, dev.label),
        status: 'live',
        url: `${appOrigin}${str(a.path, `/${str(a.handle)}/${app}`)}`,
        durationMs: Date.now() - started,
      } satisfies DeployResult;
    },

    async getPolicy(app) {
      const { raw } = await getAppWithEnvs(app);
      const source = obj(raw.app);
      if (!source.schema) throw new ApiError('not_found', 'The Control API does not expose this app’s schema to builders yet', 404);
      return { schema: AppSchema.parse(source.schema), matrix: PolicyMatrix.parse(source.policy ?? {}), notes: [] };
    },

    async savePolicy() {
      throw unavailable('Editing access rules (they ship with a deploy)');
    },

    async getAccessSamples() {
      // "Preview as" needs rows read as another member; the Control API has no route for that.
      return null;
    },

    async getMetrics(app, range) {
      const body = await optional(request('GET', `/v1/apps/${seg(app)}/metrics?range=${seg(range)}`)); // PROVISIONAL
      return body ? (obj(body.metrics ?? body) as unknown as AppMetrics) : null;
    },

    async getQa(app) {
      const body = await optional(request('GET', `/v1/apps/${seg(app)}/qa`)); // PROVISIONAL
      return body ? (obj(body.qa ?? body) as unknown as QaSummary) : null;
    },

    async getBuilderThread(app, tab) {
      const body = await optional(request('GET', `/v1/apps/${seg(app)}/builder/thread?tab=${seg(tab)}`)); // PROVISIONAL
      return body ? (arr(body.messages) as unknown as ChatMessage[]) : [];
    },

    async sendBuilderMessage() {
      throw unavailable('The Builder workspace chat');
    },
  };
  return api;
}
