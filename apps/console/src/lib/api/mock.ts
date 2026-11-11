// In-memory ConsoleApi backed by the prototype fixtures. It behaves like the Control API is
// expected to: approving a proposal that carries a grant connects it, allowing a grant approves
// its proposal, publishing bumps the version and clears the unpublished change.
import { PolicyMatrix } from '@kelay/contracts';
import { allowsRow, effectiveScope, scopeOf, visibleSamples } from '../policy';
import { ApiError, notFound } from './errors';
import {
  APPS,
  BASE_URL,
  BOARD,
  CONSENTS,
  GRANTS,
  GRAPH_OVERVIEW,
  ME,
  MEMBERSHIPS,
  PEOPLE,
  QA,
  REPORTS,
  TEMPLATES,
  THREADS,
  TICKETS,
  TOOL_CALLS,
  boardSamples,
  metricsFor,
  type Membership,
  type MockApp,
  type Person,
} from './fixtures';
import type {
  AppDetail,
  AppSummary,
  Builder,
  ChatMessage,
  ConsoleApi,
  Consent,
  FeedbackTicket,
  Grant,
  ImprovementReport,
  Member,
  Proposal,
  ProposalDecision,
  QaSummary,
  TicketReply,
  ToolCall,
  WorkspaceTab,
} from './types';

export interface MockState {
  now: number;
  seq: number;
  me: Builder;
  apps: MockApp[];
  people: Person[];
  memberships: Membership[];
  tickets: FeedbackTicket[];
  reports: ImprovementReport[];
  grants: Grant[];
  consents: Consent[];
  toolCalls: Record<string, ToolCall[]>;
  threads: Record<string, ChatMessage[]>;
  qa: Record<string, QaSummary>;
  /** Replies the builder sent, keyed by `app:ticket key`. */
  replies: Record<string, TicketReply[]>;
}

const KST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

export function createMockState(now: number = Date.now()): MockState {
  const today = KST_DATE.format(now);
  const toolCalls: Record<string, ToolCall[]> = {};
  for (const [app, calls] of Object.entries(TOOL_CALLS)) {
    toolCalls[app] = calls.map(({ time, ...c }) => ({ ...c, at: new Date(`${today}T${time}:00+09:00`).toISOString() }));
  }
  return structuredClone({
    now,
    seq: 0,
    me: ME,
    apps: APPS.map((a) => ({ ...a, updatedAt: new Date(now - a.updatedAgo).toISOString() })),
    people: PEOPLE,
    memberships: MEMBERSHIPS,
    tickets: TICKETS,
    reports: REPORTS,
    grants: GRANTS,
    consents: CONSENTS.map(({ lastUsedAgo, ...c }) => ({ ...c, lastUsedAt: new Date(now - lastUsedAgo).toISOString() })),
    toolCalls,
    threads: {},
    qa: QA,
    replies: {},
  });
}

const globalForMock = globalThis as typeof globalThis & { __kelayConsoleMock?: MockState };

/** One state per server process; route modules may be instantiated more than once in dev. */
export function getMockState(): MockState {
  globalForMock.__kelayConsoleMock ??= createMockState();
  return globalForMock.__kelayConsoleMock;
}

const clone = <T>(v: T): T => structuredClone(v);

const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(?![a-z])/, 'app-').slice(0, 60) || 'app';

const nextVersion = (v: string | null): string => (v ? `v${Number(v.replace(/^v/, '')) + 1}` : 'v1');

export function createMockApi(state: MockState = getMockState()): ConsoleApi {
  const nowIso = () => new Date().toISOString();
  const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++state.seq}`;

  const findApp = (app: string): MockApp => {
    const a = state.apps.find((x) => x.id === app);
    if (!a) throw notFound(`App ${app}`);
    return a;
  };

  const summary = (a: MockApp): AppSummary => ({
    id: a.id, handle: a.handle, name: a.name, emoji: a.emoji, color: a.color, description: a.description,
    status: a.status, users: a.users, runs: a.runs, updatedAt: a.updatedAt,
    newFeedback: state.tickets.filter((t) => t.app === a.id && t.status === 'new').length,
  });

  const detail = (a: MockApp): AppDetail => ({
    ...summary(a),
    productionUrl: a.productionUrl, mcpEndpoint: a.mcpEndpoint, previewUrl: a.previewUrl,
    version: a.version, pendingChange: a.pendingChange,
  });

  const toMember = (m: Membership): Member => {
    const p = state.people.find((x) => x.userId === m.userId);
    if (!p) throw notFound(`User ${m.userId}`);
    const consent = state.consents.find((c) => c.app === m.app && c.userId === m.userId);
    return {
      userId: p.userId, name: p.name, email: p.email, role: m.role, plan: m.plan, status: m.status, provider: p.provider,
      createdAt: p.createdAt,
      lastSignInAt: p.lastSignInAgo === null ? null : new Date(state.now - p.lastSignInAgo).toISOString(),
      assistant: consent?.client.name ?? null,
      otherApps: state.memberships
        .filter((o) => o.userId === m.userId && o.app !== m.app)
        .map((o) => ({ app: o.app, name: state.apps.find((a) => a.id === o.app)?.name ?? o.app, role: o.role })),
      color: p.color,
    };
  };

  const findMembership = (app: string, userId: string): Membership => {
    const m = state.memberships.find((x) => x.app === app && x.userId === userId);
    if (!m) throw notFound(`Member ${userId}`);
    return m;
  };

  const findProposal = (pid: string): Proposal => {
    for (const r of state.reports) {
      const p = r.proposals.find((x) => x.id === pid);
      if (p) return p;
    }
    throw notFound(`Proposal ${pid}`);
  };

  const findGrant = (gid: string): Grant => {
    const g = state.grants.find((x) => x.id === gid);
    if (!g) throw notFound(`Grant ${gid}`);
    return g;
  };

  const decide = (p: Proposal, grant: Grant | null): ProposalDecision => clone({ proposal: p, grant });

  const findTicket = (app: string, key: string): FeedbackTicket => {
    const t = state.tickets.find((x) => x.app === app && x.key === key);
    if (!t) throw notFound(`Ticket ${key}`);
    return t;
  };

  const policyOf = (a: MockApp) => ({
    ...a.policy,
    version: a.version,
    draft: a.rulesSavedAt ? { version: nextVersion(a.version), savedAt: a.rulesSavedAt } : null,
  });

  const thread = (app: string, tab: WorkspaceTab): ChatMessage[] => {
    const key = `${app}:${tab}`;
    const existing = state.threads[key];
    if (existing) return existing;
    const seeded = app === 'ticket-board' ? clone(THREADS[tab] ?? THREADS.screen ?? []) : [];
    state.threads[key] = seeded;
    return seeded;
  };

  const publish = async (app: string) => {
    const a = findApp(app);
    a.version = nextVersion(a.version);
    a.status = 'live';
    a.pendingChange = null;
    a.rulesSavedAt = null;
    a.updatedAt = nowIso();
    return { app, env: 'prod' as const, version: a.version, status: 'live' as const, url: a.productionUrl, durationMs: 18000 };
  };

  return {
    mode: 'mock',

    async getMe() {
      return clone(state.me);
    },

    async listApps() {
      return state.apps.map(summary);
    },

    async getApp(app) {
      return detail(findApp(app));
    },

    async createApp({ prompt }) {
      const text = prompt.trim();
      if (!text) throw new ApiError('invalid_request', 'Describe the app to build', 400);
      const tpl = TEMPLATES.find((t) => t.match.test(text));
      const source = tpl?.from ? findApp(tpl.from) : null;
      const name = tpl?.name ?? 'Untitled app';
      const base = slugify(name);
      let slug = base;
      for (let n = 2; state.apps.some((a) => a.id === slug); n++) slug = `${base}-${n}`;
      const policy = source
        ? clone({ ...source.policy, schema: { ...source.policy.schema, app: slug }, notes: [] })
        : {
            schema: { app: slug, roles: ['admin', 'member'], collections: [{ name: 'items', label: 'Items', fields: { title: { type: 'text' as const, required: true } } }] },
            matrix: { admin: { items: { read: 'all', create: 'all', update: 'all', delete: 'all' } }, member: { items: { read: 'all', create: 'all', update: 'mine', delete: 'mine' } } },
            notes: [],
          } satisfies MockApp['policy'];
      const created: MockApp = {
        id: slug, handle: state.me.handle, name, emoji: tpl?.emoji ?? '✨', color: tpl?.color ?? '#eef1ff',
        description: tpl?.description ?? text.slice(0, 120), status: 'draft', users: 0, runs: null, newFeedback: 0,
        updatedAt: nowIso(), updatedAgo: 0,
        productionUrl: `${BASE_URL}/${state.me.handle}/${slug}`, mcpEndpoint: `${BASE_URL}/${state.me.handle}/${slug}/mcp`,
        previewUrl: null, version: null, pendingChange: null, template: source?.template ?? null, policy,
      };
      state.apps.push(created);
      return summary(created);
    },

    async getPreview(app) {
      const a = findApp(app);
      if (a.previewUrl) return { kind: 'url', url: a.previewUrl };
      if (a.template === 'ticket-board') return { kind: 'fixture', board: clone(BOARD) };
      return null;
    },

    async listMembers(app) {
      findApp(app);
      return state.memberships.filter((m) => m.app === app).map(toMember);
    },

    async updateMember(app, userId, patch) {
      const a = findApp(app);
      const m = findMembership(app, userId);
      if (patch.role !== undefined) {
        if (!a.policy.schema.roles.includes(patch.role)) throw new ApiError('invalid_request', `Unknown role ${patch.role}`, 400);
        m.role = patch.role;
      }
      if (patch.status !== undefined) m.status = patch.status;
      if (patch.plan !== undefined) m.plan = patch.plan;
      return toMember(m);
    },

    async removeMember(app, userId) {
      const a = findApp(app);
      const m = findMembership(app, userId);
      state.memberships = state.memberships.filter((x) => x !== m);
      state.consents = state.consents.filter((c) => !(c.app === app && c.userId === userId));
      a.users = Math.max(0, a.users - 1);
    },

    async sendPasswordRecovery(app, userId) {
      findMembership(app, userId);
    },

    async listTickets(app) {
      findApp(app);
      return clone(state.tickets.filter((t) => t.app === app));
    },

    async updateTicket(app, key, patch) {
      const t = findTicket(app, key);
      Object.assign(t, patch);
      return clone(t);
    },

    async getTicketThread(app, key) {
      const t = findTicket(app, key);
      const auto: TicketReply[] = [
        { id: `${t.id}-auto`, who: 'Kelay · auto-reply', at: null, text: `Thanks! Logged as ${t.key}. ${t.votes - 1} others asked for the same. We’ll tell you when it ships.` },
      ];
      if (t.fixedIn) {
        auto.push({ id: `${t.id}-fixed`, who: 'Kelay · after you approved', at: null, text: `This is fixed in ${t.fixedIn}. Try it again — and send another /feedback if anything’s off.` });
      }
      return clone([...auto, ...(state.replies[`${app}:${key}`] ?? [])]);
    },

    async replyToTicket(app, key, text) {
      const t = findTicket(app, key);
      const reply: TicketReply = { id: id('reply'), who: `${state.me.name} · reply`, text, at: nowIso() };
      (state.replies[`${app}:${key}`] ??= []).push(reply);
      t.replies += 1;
      return clone(reply);
    },

    async listReports(app) {
      findApp(app);
      return clone(state.reports.filter((r) => r.app === app).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    },

    async runReport(app) {
      findApp(app);
      const open = state.tickets.filter((t) => t.app === app && t.status !== 'done');
      const report: ImprovementReport = {
        id: id('rep'), app, createdAt: nowIso(), author: 'Self-Improvement Agent', messages: open.length, valid: open.length,
        summary: open.length
          ? `Looked at **${open.length} open tickets**. Each one is already covered by a proposal in an earlier report, so there is nothing new to approve.`
          : 'No open feedback right now. I’ll keep watching **/feedback** and the error rate.',
        proposals: [],
      };
      state.reports.push(report);
      return clone(report);
    },

    async approveProposal(pid) {
      const p = findProposal(pid);
      p.state = 'approved';
      let grant: Grant | null = null;
      if (p.grantId) {
        grant = findGrant(p.grantId);
        grant.status = 'connected';
        grant.since = nowIso();
      }
      return decide(p, grant);
    },

    async rejectProposal(pid) {
      const p = findProposal(pid);
      p.state = 'rejected';
      return decide(p, p.grantId ? findGrant(p.grantId) : null);
    },

    async reopenProposal(pid) {
      const p = findProposal(pid);
      p.state = 'pending';
      let grant: Grant | null = null;
      if (p.grantId) {
        grant = findGrant(p.grantId);
        if (grant.status === 'connected') grant.status = 'pending';
      }
      return decide(p, grant);
    },

    async listGrants() {
      return clone(state.grants.filter((g) => g.status !== 'rejected'));
    },

    async requestGrant(input) {
      const known = (n: string) => n === 'agents' || state.apps.some((a) => a.id === n);
      if (!known(input.from) || !known(input.to) || input.from === input.to) {
        throw new ApiError('invalid_request', 'Pick two different apps', 400);
      }
      const g: Grant = { id: id('grant'), ...input, status: 'pending', callsPerDay: 0, since: nowIso(), proposalId: null };
      state.grants.push(g);
      return clone(g);
    },

    async allowGrant(gid) {
      const g = findGrant(gid);
      g.status = 'connected';
      g.since = nowIso();
      if (g.proposalId) findProposal(g.proposalId).state = 'approved';
      return clone(g);
    },

    async rejectGrant(gid) {
      const g = findGrant(gid);
      g.status = 'rejected';
      return clone(g);
    },

    async getGraphOverview() {
      return clone(GRAPH_OVERVIEW);
    },

    async listConsents(app) {
      return clone(app ? state.consents.filter((c) => c.app === app) : state.consents);
    },

    async revokeConsent(app, cid) {
      if (!state.consents.some((c) => c.id === cid && c.app === app)) throw notFound(`Consent ${cid}`);
      state.consents = state.consents.filter((c) => c.id !== cid);
    },

    async listToolCalls(app) {
      findApp(app);
      return clone(state.toolCalls[app] ?? []);
    },

    async deploy(app, env) {
      const a = findApp(app);
      if (env === 'prod') return publish(app);
      a.rulesSavedAt = null;
      return { app, env, version: a.version ?? 'v0', status: 'live', url: `https://dev.kelay.app/${a.handle}/${a.id}`, durationMs: 9000 };
    },

    publish,

    async getPolicy(app) {
      return clone(policyOf(findApp(app)));
    },

    async savePolicy(app, matrix) {
      const a = findApp(app);
      const parsed = PolicyMatrix.parse(matrix);
      const collections = new Set(a.policy.schema.collections.map((c) => c.name));
      for (const [role, byCollection] of Object.entries(parsed)) {
        if (!a.policy.schema.roles.includes(role)) throw new ApiError('invalid_request', `Unknown role ${role}`, 400);
        for (const c of Object.keys(byCollection)) {
          if (!collections.has(c)) throw new ApiError('invalid_request', `Unknown collection ${c}`, 400);
        }
      }
      a.policy.matrix = parsed;
      a.rulesSavedAt = nowIso();
      a.pendingChange = { title: 'Access rules changed', count: (a.pendingChange?.count ?? 0) + 1 };
      return clone(policyOf(a));
    },

    // The mock has no database: rows come from the board fixture and the saved rules decide.
    async previewAccess(app, userId) {
      const a = findApp(app);
      const m = state.memberships.find((x) => x.app === app && x.userId === userId);
      if (!m || a.template !== 'ticket-board') return null;
      const { schema, matrix } = a.policy;
      return {
        userId,
        role: m.role,
        version: null,
        collections: schema.collections.map((c) => {
          const samples = c.name === 'tickets' ? boardSamples(BOARD) : [];
          const scope = (op: 'update' | 'delete' | 'create') => effectiveScope(c, scopeOf(matrix, m.role, c.name, op));
          const rows = visibleSamples(c, matrix, m.role, userId, samples).map((r) => ({
            ...r,
            canUpdate: allowsRow(scope('update'), r, userId),
            canDelete: allowsRow(scope('delete'), r, userId),
          }));
          return {
            collection: c.name,
            label: c.label ?? c.name,
            readable: rows.length,
            editable: rows.filter((r) => r.canUpdate).length,
            deletable: rows.filter((r) => r.canDelete).length,
            canCreate: scope('create') !== 'none',
            total: samples.length,
            rows,
          };
        }),
      };
    },

    async getMetrics(app, range) {
      findApp(app);
      return metricsFor(app, range, state.now);
    },

    async getQa(app) {
      findApp(app);
      return clone(state.qa[app] ?? null);
    },

    async runQa(app) {
      findApp(app);
      const qa = state.qa[app];
      if (!qa) throw new ApiError('conflict', 'Nothing to check yet. Checks are generated on the first deploy.', 409);
      qa.finishedAt = nowIso();
      return clone(qa);
    },

    async getBuilderSession(app) {
      findApp(app);
      return null;
    },

    async getBuilderThread(app, tab) {
      findApp(app);
      return clone(thread(app, tab));
    },

    async sendBuilderMessage(app, tab, message) {
      findApp(app);
      const t = thread(app, tab);
      t.push(
        { id: id('msg'), role: 'user', author: null, parts: [{ kind: 'text', text: message }] },
        { id: id('msg'), role: 'agent', author: 'Builder', parts: [{ kind: 'text', text: 'Got it. I’ll make that change in Development and tell you here when it’s ready to **ship**.' }] },
      );
      return clone(t);
    },
  };
}
