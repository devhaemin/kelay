// ConsoleApi over the Control API. Lists may come back bare or wrapped (`{ apps: [...] }`).
// Routes marked PROVISIONAL are not in the Control API route list yet (see PROTOTYPE_SYNC.md):
// reads treat 404 as "not available" and return null; writes surface the error.
import { AppSchema, PolicyMatrix } from '@kelay/contracts';
import { ApiError, isApiError } from './errors';
import type {
  AppDetail,
  AppPolicy,
  AppSummary,
  Builder,
  ChatMessage,
  ConsoleApi,
  Consent,
  DeployResult,
  FeedbackTicket,
  Grant,
  ImprovementReport,
  Member,
  PolicyNote,
  Proposal,
  ProposalDecision,
  QaSummary,
  ToolCall,
  AppMetrics,
  GraphOverview,
} from './types';

export interface HttpApiOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

const STATUS_CODES: Record<number, string> = { 400: 'invalid_request', 401: 'unauthenticated', 403: 'denied', 404: 'not_found', 409: 'conflict', 429: 'rate_limited' };

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function list<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  if (isObject(body) && Array.isArray(body[key])) return body[key] as T[];
  if (isObject(body) && Array.isArray(body.data)) return body.data as T[];
  throw new ApiError('internal', `Unexpected response: expected a list of ${key}`, 502);
}

function item<T>(body: unknown, key: string): T {
  if (isObject(body) && isObject(body[key])) return body[key] as T;
  if (isObject(body) && isObject(body.data)) return body.data as T;
  return body as T;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function createHttpApi({ baseUrl, token, fetch: fetchImpl = fetch }: HttpApiOptions): ConsoleApi {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    if (res.status === 204) return undefined as T;
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = isObject(json) && isObject(json.error) ? json.error : {};
      throw new ApiError(str(err.code, STATUS_CODES[res.status] ?? 'internal'), str(err.message, `${method} ${path} failed (${res.status})`), res.status);
    }
    return json as T;
  }

  async function optional<T>(p: Promise<T>): Promise<T | null> {
    try {
      return await p;
    } catch (e) {
      if (isApiError(e) && e.status === 404) return null;
      throw e;
    }
  }

  const seg = encodeURIComponent;

  function toSummary(raw: Json): AppSummary {
    const id = str(raw.id) || str(raw.slug);
    return {
      id,
      handle: str(raw.handle),
      name: str(raw.name, id),
      emoji: str(raw.emoji, '✨'),
      color: str(raw.color, '#eef1ff'),
      description: str(raw.description),
      status: raw.status === 'live' || raw.status === 'paused' ? raw.status : 'draft',
      users: num(raw.users),
      runs: typeof raw.runs === 'number' ? raw.runs : null,
      newFeedback: num(raw.newFeedback),
      updatedAt: str(raw.updatedAt) || str(raw.updated_at) || new Date(0).toISOString(),
    };
  }

  function toDetail(raw: Json): AppDetail {
    const s = toSummary(raw);
    const pending = isObject(raw.pendingChange) ? raw.pendingChange : null;
    return {
      ...s,
      productionUrl: str(raw.productionUrl, `https://kelay.app/${s.handle}/${s.id}`),
      mcpEndpoint: str(raw.mcpEndpoint, `https://kelay.app/${s.handle}/${s.id}/mcp`),
      previewUrl: typeof raw.previewUrl === 'string' ? raw.previewUrl : null,
      version: typeof raw.version === 'string' ? raw.version : null,
      pendingChange: pending ? { title: str(pending.title), count: num(pending.count, 1) } : null,
    };
  }

  // app_members rows are snake_case in the control DB (contracts §9); accept either spelling.
  function toMember(raw: Json): Member {
    return {
      userId: str(raw.userId) || str(raw.user_id),
      name: str(raw.name) || str(raw.email) || str(raw.userId) || str(raw.user_id),
      email: str(raw.email),
      role: str(raw.role, 'member'),
      plan: str(raw.plan, 'free'),
      status: raw.status === 'unconfirmed' || raw.status === 'banned' ? raw.status : 'active',
      provider: raw.provider === 'google' || raw.provider === 'kakao' || raw.provider === 'github' ? raw.provider : 'email',
      createdAt: str(raw.createdAt) || str(raw.created_at) || new Date(0).toISOString(),
      lastSignInAt: str(raw.lastSignInAt) || str(raw.last_sign_in_at) || null,
      assistant: str(raw.assistant) || null,
      otherApps: Array.isArray(raw.otherApps) ? (raw.otherApps as Member['otherApps']) : [],
    };
  }

  function toDecision(body: unknown): ProposalDecision {
    if (isObject(body) && isObject(body.proposal)) {
      return { proposal: body.proposal as unknown as Proposal, grant: isObject(body.grant) ? (body.grant as unknown as Grant) : null };
    }
    return { proposal: body as Proposal, grant: null };
  }

  async function getRawApp(app: string): Promise<Json> {
    return item<Json>(await request('GET', `/v1/apps/${seg(app)}`), 'app');
  }

  const api: ConsoleApi = {
    mode: 'http',

    async getMe() {
      const me = await optional(request<unknown>('GET', '/v1/me')); // PROVISIONAL
      if (me) return item<Builder>(me, 'builder');
      const apps = await api.listApps();
      const handle = apps[0]?.handle ?? 'me';
      return { name: handle, handle, email: '', team: '' };
    },

    async listApps() {
      return list<Json>(await request('GET', '/v1/apps'), 'apps').map(toSummary);
    },

    async getApp(app) {
      return toDetail(await getRawApp(app));
    },

    async createApp({ prompt }) {
      return toSummary(item<Json>(await request('POST', '/v1/apps', { prompt }), 'app'));
    },

    async getPreview(app) {
      const a = await api.getApp(app);
      return a.previewUrl ? { kind: 'url', url: a.previewUrl } : null;
    },

    async listMembers(app) {
      return list<Json>(await request('GET', `/v1/apps/${seg(app)}/members`), 'members').map(toMember);
    },

    async updateMember(app, userId, patch) {
      return toMember(item<Json>(await request('PATCH', `/v1/apps/${seg(app)}/members/${seg(userId)}`, patch), 'member'));
    },

    async removeMember(app, userId) {
      await request('DELETE', `/v1/apps/${seg(app)}/members/${seg(userId)}`);
    },

    async sendPasswordRecovery(app, userId) {
      await request('POST', `/v1/apps/${seg(app)}/members/${seg(userId)}/recovery`); // PROVISIONAL
    },

    async listTickets(app) {
      return list<FeedbackTicket>(await request('GET', `/v1/apps/${seg(app)}/tickets`), 'tickets');
    },

    async updateTicket(id, patch) {
      return item<FeedbackTicket>(await request('PATCH', `/v1/tickets/${seg(id)}`, patch), 'ticket');
    },

    async listReports(app) {
      const reports = list<ImprovementReport>(await request('GET', `/v1/apps/${seg(app)}/reports`), 'reports');
      return [...reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async runReport(app) {
      return item<ImprovementReport>(await request('POST', `/v1/apps/${seg(app)}/reports/run`), 'report');
    },

    async approveProposal(id) {
      return toDecision(await request('POST', `/v1/proposals/${seg(id)}/approve`));
    },

    async rejectProposal(id) {
      return toDecision(await request('POST', `/v1/proposals/${seg(id)}/reject`));
    },

    async reopenProposal(id) {
      return toDecision(await request('POST', `/v1/proposals/${seg(id)}/reopen`)); // PROVISIONAL
    },

    async listGrants() {
      return list<Grant>(await request('GET', '/v1/grants'), 'grants').filter((g) => g.status !== 'rejected');
    },

    async requestGrant(input) {
      return item<Grant>(await request('POST', '/v1/grants', input), 'grant');
    },

    async allowGrant(id) {
      return item<Grant>(await request('POST', `/v1/grants/${seg(id)}/allow`), 'grant');
    },

    async rejectGrant(id) {
      return item<Grant>(await request('POST', `/v1/grants/${seg(id)}/reject`), 'grant');
    },

    async getGraphOverview() {
      const body = await optional(request<unknown>('GET', '/v1/graph/overview')); // PROVISIONAL
      return body ? item<GraphOverview>(body, 'overview') : null;
    },

    async listConsents(app) {
      const consents = list<Consent>(await request('GET', '/v1/me/consents'), 'consents');
      return app ? consents.filter((c) => c.app === app) : consents;
    },

    async revokeConsent(id) {
      await request('DELETE', `/v1/me/consents/${seg(id)}`);
    },

    async listToolCalls(app) {
      const body = await optional(request<unknown>('GET', `/v1/apps/${seg(app)}/tool-calls`)); // PROVISIONAL
      return body ? list<ToolCall>(body, 'toolCalls') : null;
    },

    async deploy(app, env) {
      return item<DeployResult>(await request('POST', `/v1/apps/${seg(app)}/envs/${seg(env)}/deploy`), 'deploy');
    },

    async publish(app) {
      return item<DeployResult>(await request('POST', `/v1/apps/${seg(app)}/publish`), 'deploy');
    },

    async getPolicy(app) {
      const raw = await getRawApp(app);
      if (!raw.schema) throw new ApiError('not_found', 'This app has no schema yet', 404);
      return {
        schema: AppSchema.parse(raw.schema),
        matrix: PolicyMatrix.parse(raw.policy ?? {}),
        notes: Array.isArray(raw.policyNotes) ? (raw.policyNotes as PolicyNote[]) : [],
      } satisfies AppPolicy;
    },

    async savePolicy(app, matrix) {
      await request('PUT', `/v1/apps/${seg(app)}/policy`, { policy: PolicyMatrix.parse(matrix) }); // PROVISIONAL
      return api.getPolicy(app);
    },

    async getAccessSamples() {
      // "Preview as" needs rows read as another member; no Control API route exists for that yet.
      return null;
    },

    async getMetrics(app, range) {
      const body = await optional(request<unknown>('GET', `/v1/apps/${seg(app)}/metrics?range=${seg(range)}`)); // PROVISIONAL
      return body ? item<AppMetrics>(body, 'metrics') : null;
    },

    async getQa(app) {
      const body = await optional(request<unknown>('GET', `/v1/apps/${seg(app)}/qa`)); // PROVISIONAL
      return body ? item<QaSummary>(body, 'qa') : null;
    },

    async getBuilderThread(app, tab) {
      const body = await optional(request<unknown>('GET', `/v1/apps/${seg(app)}/builder/thread?tab=${seg(tab)}`)); // PROVISIONAL
      return body ? list<ChatMessage>(body, 'messages') : [];
    },

    async sendBuilderMessage(app, tab, text) {
      const body = await request<unknown>('POST', `/v1/apps/${seg(app)}/builder/messages`, { tab, text }); // PROVISIONAL
      return list<ChatMessage>(body, 'messages');
    },
  };
  return api;
}
