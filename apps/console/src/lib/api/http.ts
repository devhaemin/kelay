// ConsoleApi over the Control API (services/control-api, routes in its README). Responses are
// mapped from the Control API's views (slug, purpose, fromApp, ...) to the console's types. Reads
// the Control API has no route for yet are marked PROVISIONAL: a 404 means "not available".
import { AppSchema, PolicyMatrix } from '@kelay/contracts';
import { threadFromEvents, type BuilderEvent, type BuilderSession } from '../builder';
import { ApiError, isApiError } from './errors';
import type {
  AccessPreview,
  AccessSample,
  AppDetail,
  AppMetrics,
  AppPolicy,
  AppSummary,
  AssistantKind,
  Builder,
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
  QaCheck,
  QaSummary,
  RecentAction,
  TicketReply,
  ToolCall,
} from './types';

export interface HttpApiOptions {
  baseUrl: string;
  token: string;
  /** Origin public app URLs are served from (`/<handle>/<app>`). */
  appOrigin?: string;
  /** MCP_PUBLIC_BASE_URL of the MCP gateway (contracts §7). */
  mcpBaseUrl?: string;
  /** BUILDER_URL of the Builder (services/builder). Without it, apps have no workspace, preview or chat. */
  builderUrl?: string;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

const STATUS_CODES: Record<number, string> = { 400: 'invalid_request', 401: 'unauthenticated', 403: 'denied', 404: 'not_found', 409: 'conflict', 429: 'rate_limited' };
const REPORTS_WITH_PROPOSALS = 5;
const PROVIDERS = ['google', 'email', 'kakao', 'github'] as const;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);
const obj = (v: unknown): Json => (isObject(v) ? v : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObject) : []);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map((n) => num(n)) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

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

export function createHttpApi({ baseUrl, token, appOrigin = 'https://kelay.app', mcpBaseUrl = appOrigin, builderUrl, fetch: fetchImpl = fetch }: HttpApiOptions): ConsoleApi {
  async function request(method: string, path: string, body?: unknown, base = baseUrl): Promise<Json> {
    const res = await fetchImpl(new URL(path, base), {
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

  /** A call to the Builder with the same builder token. Null when no Builder is configured or the app has no workspace there. */
  async function builder(method: string, path: string, body?: unknown): Promise<Json | null> {
    if (!builderUrl) return null;
    return optional(request(method, path, body, builderUrl));
  }

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

  // app_members rows (contracts §9) with the person's Kelay ID profile: name, email, provider, sign-in times.
  function toMember(raw: Json): Member {
    const userId = str(raw.userId) || str(raw.user_id);
    return {
      userId,
      // A member Kelay ID has no account for has no profile; the head of the id stands in for the name.
      name: str(raw.name) || str(raw.email) || (userId.length > 12 ? `${userId.slice(0, 8)}…` : userId),
      email: str(raw.email),
      role: str(raw.role, 'member'),
      plan: str(raw.plan, 'free'),
      status: oneOf(raw.status, ['active', 'unconfirmed', 'banned'] as const, 'active'),
      provider: PROVIDERS.find((p) => p === raw.provider) ?? null,
      createdAt: str(raw.createdAt) || str(raw.created_at) || null,
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
      refs: strs(raw.refs),
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
      callsPerDay: num(raw.callsPerDay),
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
      scopes: strs(raw.scopes),
      grantedAt: str(raw.createdAt),
      lastUsedAt: str(raw.lastUsedAt) || null,
    };
  }

  function toReply(raw: Json, reporter: string): TicketReply {
    const actor = str(raw.actor);
    return {
      id: str(raw.id),
      who: actor === reporter ? 'Reporter · reply' : actor.startsWith('service:') ? 'Kelay · reply' : 'Team · reply',
      text: str(obj(raw.data).text),
      at: str(raw.createdAt) || null,
    };
  }

  function toPolicy(body: Json): AppPolicy {
    const draft = isObject(body.draft) ? body.draft : null;
    return {
      schema: AppSchema.parse(body.schema),
      matrix: PolicyMatrix.parse(draft?.policy ?? body.policy ?? {}),
      notes: arr(body.notes).map((n) => ({
        role: str(n.role),
        collection: str(n.collection),
        op: oneOf(n.op, ['read', 'create', 'update', 'delete'] as const, 'read'),
        from: str(n.from),
      })),
      version: str(obj(body.version).label) || null,
      draft: draft ? { version: str(draft.label), savedAt: str(draft.createdAt) } : null,
    };
  }

  function toPreview(raw: Json): AccessPreview {
    const as = obj(raw.as);
    return {
      userId: str(as.userId),
      role: str(as.role),
      version: str(obj(raw.version).label) || null,
      collections: arr(raw.collections).map((c) => ({
        collection: str(c.collection),
        label: str(c.label, str(c.collection)),
        readable: num(obj(c.read).count),
        editable: num(obj(c.update).count),
        deletable: num(obj(c.delete).count),
        canCreate: obj(c.create).allowed === true,
        total: null,
        rows: arr(c.rows).map(
          (r): AccessSample => ({
            id: str(r.id),
            label: str(r.label, str(r.id)),
            ownerId: str(r.ownerId) || null,
            createdBy: str(r.createdBy) || null,
            shared: r.shared === true,
            canUpdate: r.canUpdate === true,
            canDelete: r.canDelete === true,
          }),
        ),
      })),
    };
  }

  function toMetrics(raw: Json): AppMetrics {
    const active = obj(raw.activeMembers);
    const today = obj(raw.actionsToday);
    const errors = obj(raw.screenErrors7d);
    const series = obj(raw.series);
    return {
      range: oneOf(raw.range, ['24h', '14d', '30d'] as const, '24h'),
      healthy: raw.healthy !== false,
      activeMembers: { value: num(active.value), total: num(active.total), delta: num(active.delta) },
      actionsToday: { value: num(today.value), deltaPct: num(today.deltaPct) },
      screenErrors7d: { value: num(errors.value), note: str(errors.note) || null },
      agentActionsToday: num(raw.agentActionsToday),
      llmBudgetTodayUsd: num(raw.llmBudgetTodayUsd),
      series: { buckets: strs(series.buckets), actions: nums(series.actions), errors: nums(series.errors) },
      recent: arr(raw.recent).map(
        (r): RecentAction => ({
          id: str(r.id),
          action: str(r.action),
          by: str(r.by),
          status: oneOf(r.status, ['ok', 'blocked', 'error'] as const, 'ok'),
          ms: num(r.ms),
          source: str(r.source),
          args: str(r.args) || null,
          at: str(r.at) || null,
        }),
      ),
    };
  }

  function toToolCall(raw: Json): ToolCall {
    return {
      id: str(raw.id),
      consentId: str(raw.consentId) || null,
      at: str(raw.at),
      tool: str(raw.tool),
      args: str(raw.args),
      result: oneOf(raw.result, ['ok', 'denied', 'error'] as const, 'ok'),
      note: str(raw.note) || null,
      userId: str(raw.userId) || null,
      clientName: str(raw.clientName) || null,
    };
  }

  function toQa(raw: Json): QaSummary {
    const checks = arr(raw.checks).map(
      (c): QaCheck => ({
        name: str(c.name),
        status: c.status === 'ok' ? 'ok' : 'bad',
        durationMs: num(c.durationMs),
        note: str(c.note) || null,
        role: str(c.role) || null,
      }),
    );
    return {
      passing: num(raw.passing),
      total: num(raw.total, checks.length),
      errorsReachedUsers7d: num(raw.errorsReachedUsers7d),
      checks,
      incidents: arr(raw.incidents).map((i) => ({
        title: str(i.title),
        resolved: i.resolved === true,
        timeline: arr(i.timeline).map((t) => ({ when: str(t.when) || str(t.at), tone: t.tone === 'red' || t.tone === 'green' ? t.tone : null, text: str(t.text) })),
      })),
      error: raw.status === 'error' ? str(raw.error, 'The run could not finish.') : null,
      version: str(raw.version) || null,
      finishedAt: str(raw.finishedAt) || null,
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
      // 404 only from a Control API older than the route.
      const body = await optional(request('GET', '/v1/me'));
      if (body) {
        const me = obj(body.me);
        const handle = str(me.handle);
        const email = str(me.email);
        // The builder's org is the team their apps are for. A builder who signed up on their own has an org of one, named after their id.
        return { name: str(me.name) || handle || email || 'Builder', handle, email, team: me.org === me.userId ? '' : str(me.org) } satisfies Builder;
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
      const app = { slug, name, description: prompt.slice(0, 2000) };
      const me = obj((await request('GET', '/v1/me')).me);
      if (str(me.handle)) return toSummary(obj((await request('POST', '/v1/apps', app)).app));
      // A builder's first app also picks the handle all their apps live under: from their email, with a
      // suffix when someone else has it.
      const base = slugify((str(me.email).split('@')[0] || str(me.name) || 'builder').slice(0, 40)).padEnd(2, 'x');
      for (let attempt = 0; ; attempt++) {
        const handle = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
        try {
          return toSummary(obj((await request('POST', '/v1/apps', { ...app, handle })).app));
        } catch (e) {
          if (!(isApiError(e) && e.status === 409 && e.message.includes('is taken')) || attempt >= 4) throw e;
        }
      }
    },

    // The dev preview is the workspace's `next dev`, behind the Builder's preview proxy. It runs while the
    // workspace is in use. A frame cannot send the builder's token, so the Builder answers an address
    // with a short-lived ticket in it, which the proxy trades for a cookie on its own origin.
    async getPreview(app) {
      const url = str(obj((await builder('POST', `/v1/workspaces/${seg(app)}/preview`))?.preview).url);
      return url ? { kind: 'url', url } : null;
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

    async getTicketThread(app, key) {
      const body = await request('GET', `/v1/apps/${seg(app)}/tickets/${seg(key)}`);
      const reporter = str(obj(body.ticket).reporter);
      return arr(body.events).filter((e) => e.kind === 'reply').map((e) => toReply(e, reporter));
    },

    async replyToTicket(app, key, text) {
      return toReply(obj((await request('POST', `/v1/apps/${seg(app)}/tickets/${seg(key)}/replies`, { text })).event), '');
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

    async reopenProposal(id) {
      return { proposal: toProposal(obj((await request('POST', `/v1/proposals/${seg(id)}/undo`)).proposal)), grant: null } satisfies ProposalDecision;
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
      // 404 only from a Control API older than the route.
      const body = await optional(request('GET', '/v1/graph/overview'));
      if (!body) return null;
      const o = obj(body.overview);
      return {
        people: num(o.people),
        multiAppPeople: num(o.multiAppPeople),
        callsDeltaPct: typeof o.callsDeltaPct === 'number' ? o.callsDeltaPct : null,
        agentCallsPerDay: Object.fromEntries(Object.entries(obj(o.agentCallsPerDay)).map(([app, n]) => [app, num(n)])),
      } satisfies GraphOverview;
    },

    async listConsents(app) {
      const apps = app ? [app] : (await api.listApps()).map((a) => a.id);
      const lists = await Promise.all(apps.map(async (a) => arr((await request('GET', `/v1/apps/${seg(a)}/consents`)).consents)));
      return lists.flat().map(toConsent);
    },

    async revokeConsent(app, id) {
      await request('POST', `/v1/apps/${seg(app)}/consents/${seg(id)}/revoke`);
    },

    async listToolCalls(app) {
      return arr((await request('GET', `/v1/apps/${seg(app)}/tool-calls`)).toolCalls).map(toToolCall);
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

    // 404 until a version with a schema is deployed to dev.
    async getPolicy(app) {
      return toPolicy(await request('GET', `/v1/apps/${seg(app)}/schema`));
    },

    async savePolicy(app, matrix) {
      return toPolicy(await request('PUT', `/v1/apps/${seg(app)}/policy`, { policy: matrix }));
    },

    async previewAccess(app, userId) {
      try {
        return toPreview(obj((await request('POST', `/v1/apps/${seg(app)}/policy/preview`, { as: userId })).preview));
      } catch (e) {
        // 404: not a member or nothing deployed. 409: no database, or one that does not match the schema.
        if (isApiError(e) && (e.status === 404 || e.status === 409)) return null;
        throw e;
      }
    },

    async getMetrics(app, range) {
      return toMetrics(obj((await request('GET', `/v1/apps/${seg(app)}/metrics?range=${seg(range)}`)).metrics));
    },

    async getQa(app) {
      const body = await optional(request('GET', `/v1/apps/${seg(app)}/qa`));
      return body ? toQa(obj(body.qa)) : null;
    },

    async runQa(app) {
      return toQa(obj((await request('POST', `/v1/apps/${seg(app)}/qa/run`, {})).qa));
    },

    async getBuilderSession(app) {
      const status = await builder('GET', `/v1/workspaces/${seg(app)}`);
      if (!status) return null;
      const events = await builder('GET', `/v1/workspaces/${seg(app)}/events?format=json`);
      const w = obj(status.workspace);
      const agent = obj(w.agent);
      return {
        workspace: {
          app,
          state: oneOf(w.state, ['working', 'idle', 'stopped'] as const, 'stopped'),
          agent: { kind: agent.kind === 'claude' ? 'claude' : 'scripted', model: str(agent.model) || null },
          previewUrl: str(w.previewUrl) || null,
          version: str(w.version) || null,
          lastEventId: num(w.lastEventId),
        },
        // The Builder's own records, in its order; the console only reads the fields it knows.
        events: arr(events?.events) as unknown as BuilderEvent[],
      } satisfies BuilderSession;
    },

    async getBuilderThread(app) {
      const session = await api.getBuilderSession(app);
      return session ? threadFromEvents(session.events) : [];
    },

    // Starts a turn and returns the thread as it stands; the chat panel follows the rest on the event stream.
    async sendBuilderMessage(app, tab, text) {
      if (!builderUrl) throw unavailable('The Builder workspace chat');
      await request('POST', `/v1/workspaces/${seg(app)}/messages`, { text, context: tab }, builderUrl);
      return api.getBuilderThread(app, tab);
    },
  };
  return api;
}
