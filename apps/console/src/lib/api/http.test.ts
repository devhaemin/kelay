import { describe, expect, it, vi } from 'vitest';
import { createHttpApi } from './http';

type Route = (body: unknown) => { status?: number; json: unknown };

/** A fake Control API: `METHOD /path` → response, recording every call. */
function fakeControlApi(routes: Record<string, Route>) {
  const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, auth: new Headers(init?.headers).get('authorization'), body });
    const route = routes[`${method} ${url.pathname}`];
    const res = route ? route(body) : { status: 404, json: { error: { code: 'not_found', message: 'no route' } } };
    return new Response(JSON.stringify(res.json), { status: res.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  const api = createHttpApi({ baseUrl: 'http://control.test', token: 'builder-token', appOrigin: 'https://kelay.app', mcpBaseUrl: 'https://mcp.kelay.app', fetch });
  return { api, calls };
}

const appView = { slug: 'ticket-board', handle: 'orum', name: 'Ticket Board', description: '', emoji: null, color: null, status: 'live', path: '/orum/ticket-board', updatedAt: '2026-11-11T00:00:00Z' };
const version = (env: string, n: number) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, env, number: n, label: `v${n}`, commit: 'abc', artifactUrl: 's3://a', configVersion: 'c1' });

describe('Control API client', () => {
  it('maps apps and sends the builder token', async () => {
    const { api, calls } = fakeControlApi({ 'GET /v1/apps': () => ({ json: { apps: [{ ...appView, members: 12, newFeedback: 3 }] } }) });
    const [app] = await api.listApps();
    expect(app).toMatchObject({ id: 'ticket-board', handle: 'orum', users: 12, newFeedback: 3, emoji: '✨' });
    expect(calls[0]?.auth).toBe('Bearer builder-token');
  });

  it('derives the version, unpublished change and URLs from the app’s envs', async () => {
    const { api } = fakeControlApi({
      'GET /v1/apps/ticket-board': () => ({ json: { app: appView, envs: [{ name: 'dev', activeVersion: version('dev', 3) }, { name: 'prod', activeVersion: version('prod', 2) }] } }),
    });
    expect(await api.getApp('ticket-board')).toMatchObject({
      version: 'v2',
      pendingChange: { count: 1 },
      productionUrl: 'https://kelay.app/orum/ticket-board',
      mcpEndpoint: 'https://mcp.kelay.app/orum/ticket-board/mcp',
    });
  });

  it('publishes the active dev version', async () => {
    const { api, calls } = fakeControlApi({
      'GET /v1/apps/ticket-board': () => ({ json: { app: appView, envs: [{ name: 'dev', activeVersion: version('dev', 3) }, { name: 'prod', activeVersion: null }] } }),
      'POST /v1/apps/ticket-board/publish': () => ({ json: { version: version('prod', 3), app: appView } }),
    });
    expect(await api.publish('ticket-board')).toMatchObject({ env: 'prod', version: 'v3', url: 'https://kelay.app/orum/ticket-board' });
    expect(calls.at(-1)?.body).toEqual({ versionId: version('dev', 3).id });
  });

  it('maps grants both ways and loads report proposals', async () => {
    const { api, calls } = fakeControlApi({
      'POST /v1/grants': (b) => ({ status: 201, json: { grant: { id: 'g1', ...(b as object), status: 'pending', calls: 0, createdAt: '2026-11-11T00:00:00Z' } } }),
      'GET /v1/apps/ticket-board/reports': () => ({ json: { reports: [{ id: 'r1' }] } }),
      'GET /v1/apps/ticket-board/reports/r1': () => ({
        json: { report: { id: 'r1', app: 'ticket-board', summary: 'S', stats: { received: 14, valid: 8 }, createdAt: '2026-11-11T00:00:00Z' }, proposals: [{ id: 'p1', title: 'T', refs: ['FB-131'], impact: 'High', effort: 'S', status: 'built' }] },
      }),
    });
    const g = await api.requestGrant({ from: 'ticket-board', to: 'team-wiki', kind: 'A2A', what: 'Weekly notes' });
    expect(calls[0]?.body).toEqual({ fromApp: 'ticket-board', toApp: 'team-wiki', kind: 'A2A', purpose: 'Weekly notes' });
    expect(g).toMatchObject({ from: 'ticket-board', to: 'team-wiki', what: 'Weekly notes', status: 'pending' });

    const [report] = await api.listReports('ticket-board');
    expect(report).toMatchObject({ messages: 14, valid: 8, proposals: [{ id: 'p1', state: 'approved', refs: ['FB-131'] }] });
  });

  it('reads the builder profile and member profiles from the Control API', async () => {
    const member = { app: 'ticket-board', userId: 'kq3ZtB0aYp9mW2xLr7Vd', org: 'orum', role: 'member', plan: 'team', status: 'active' };
    const { api } = fakeControlApi({
      'GET /v1/me': () => ({ json: { me: { userId: 'b1', name: 'Jeongyun Lee', email: 'jeongyun@orum.test', provider: 'email', app: 'kelay-console', org: 'orum', role: 'builder', plan: 'pro', handle: 'orum' } } }),
      'GET /v1/apps/ticket-board/members': () => ({
        json: {
          members: [
            { ...member, name: 'Junho Park', email: 'junho@orum.test', provider: 'email', createdAt: '2026-10-02T00:00:00.000Z', lastSignInAt: '2026-11-11T01:00:00.000Z' },
            { ...member, userId: 'zzzzzzzzzzzzzzzzzzzz', name: null, email: null, provider: null, createdAt: null, lastSignInAt: null },
          ],
        },
      }),
    });
    expect(await api.getMe()).toEqual({ name: 'Jeongyun Lee', handle: 'orum', email: 'jeongyun@orum.test', team: 'orum' });
    const [junho, unknown] = await api.listMembers('ticket-board');
    expect(junho).toMatchObject({ name: 'Junho Park', email: 'junho@orum.test', provider: 'email', createdAt: '2026-10-02T00:00:00.000Z', lastSignInAt: '2026-11-11T01:00:00.000Z' });
    expect(unknown).toMatchObject({ name: 'zzzzzzzz…', email: '', provider: null, lastSignInAt: null });
  });

  it('names the builder after their handle when the Control API has no /v1/me', async () => {
    const { api } = fakeControlApi({ 'GET /v1/apps': () => ({ json: { apps: [appView] } }) });
    expect(await api.getMe()).toEqual({ name: 'orum', handle: 'orum', email: '', team: '' });
  });

  it('surfaces Control API errors and treats missing provisional reads as unavailable', async () => {
    const { api } = fakeControlApi({
      'POST /v1/grants/g1/allow': () => ({ status: 403, json: { error: { code: 'denied', message: 'only the target app’s owner can decide' } } }),
    });
    await expect(api.allowGrant('g1')).rejects.toMatchObject({ code: 'denied', status: 403, message: 'only the target app’s owner can decide' });
    expect(await api.getBuilderThread('ticket-board', 'screen')).toEqual([]);
  });

  it('reads the saved rules from the draft and saves the matrix with PUT policy', async () => {
    const schema = { app: 'ticket-board', roles: ['admin', 'member'], collections: [{ name: 'tickets', fields: { title: { type: 'text', required: true } } }] };
    const deployed = { member: { tickets: { read: 'all', create: 'all', update: 'mine', delete: 'none' } } };
    const saved = { member: { tickets: { read: 'mine', create: 'all', update: 'mine', delete: 'none' } } };
    const ref = (n: number) => ({ id: `v${n}`, number: n, label: `v${n}`, createdBy: 'b1', createdAt: '2026-11-11T00:00:00Z' });
    const { api, calls } = fakeControlApi({
      'GET /v1/apps/ticket-board/schema': () => ({ json: { schema, policy: deployed, notes: [], version: ref(3), draft: null } }),
      'PUT /v1/apps/ticket-board/policy': (b) => ({ json: { schema, policy: deployed, notes: [], version: ref(3), draft: { ...ref(4), policy: (b as { policy: unknown }).policy } } }),
    });
    expect(await api.getPolicy('ticket-board')).toMatchObject({ matrix: deployed, version: 'v3', draft: null });
    const next = await api.savePolicy('ticket-board', saved as never);
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { policy: saved } });
    expect(next).toMatchObject({ matrix: saved, version: 'v3', draft: { version: 'v4', savedAt: '2026-11-11T00:00:00Z' } });
  });

  it('maps "preview as" and yields null when there is nothing to preview against', async () => {
    const { api, calls } = fakeControlApi({
      'POST /v1/apps/ticket-board/policy/preview': () => ({
        json: {
          preview: {
            as: { userId: 'u1', role: 'member' },
            version: { label: 'v3' },
            collections: [
              {
                collection: 'tickets', label: 'Tickets', ownerField: 'assignee_id',
                read: { scope: 'mine_shared', allowed: true, count: 2 }, create: { scope: 'all', allowed: true },
                update: { scope: 'mine', allowed: true, count: 1 }, delete: { scope: 'none', allowed: false, count: 0 },
                rows: [{ id: 't1', label: 'Roadmap', ownerId: 'u1', createdBy: 'u2', shared: false, canUpdate: true, canDelete: false }],
              },
            ],
          },
        },
      }),
      'POST /v1/apps/team-wiki/policy/preview': () => ({ status: 409, json: { error: { code: 'conflict', message: 'the dev environment has no database yet' } } }),
    });
    expect(await api.previewAccess('ticket-board', 'u1')).toEqual({
      userId: 'u1', role: 'member', version: 'v3',
      collections: [{ collection: 'tickets', label: 'Tickets', readable: 2, editable: 1, deletable: 0, canCreate: true, total: null, rows: [{ id: 't1', label: 'Roadmap', ownerId: 'u1', createdBy: 'u2', shared: false, canUpdate: true, canDelete: false }] }],
    });
    expect(calls[0]?.body).toEqual({ as: 'u1' });
    expect(await api.previewAccess('team-wiki', 'u1')).toBeNull();
  });

  it('reads metrics, tool calls and QA, and runs the checks', async () => {
    const qa = { status: 'passed', error: null, version: 'v3', finishedAt: '2026-11-11T01:00:00Z', passing: 1, total: 1, errorsReachedUsers7d: 0, checks: [{ name: 'member can’t delete tickets', status: 'ok', durationMs: 3, note: null, role: 'member' }], incidents: [] };
    const { api, calls } = fakeControlApi({
      'GET /v1/apps/ticket-board/metrics': () => ({
        json: { metrics: { range: '24h', healthy: true, activeMembers: { value: 1, total: 5, delta: 1 }, actionsToday: { value: 2, deltaPct: 0 }, screenErrors7d: { value: 0, note: null }, agentActionsToday: 1, llmBudgetTodayUsd: 0.04, series: { buckets: ['2026-11-11T00:00:00.000Z'], actions: [2], errors: [0] }, recent: [{ id: 'r1', action: 'tickets_update', args: '{}', by: 'u1', status: 'blocked', ms: 12, source: 'App', at: '2026-11-11T00:10:00.000Z' }] } },
      }),
      'GET /v1/apps/ticket-board/tool-calls': () => ({ json: { toolCalls: [{ id: 'c1', consentId: null, at: '2026-11-11T00:10:00.000Z', tool: 'tickets_list', args: '{}', result: 'error', note: null, userId: 'u1', clientId: 'x', clientName: 'Claude Desktop', ms: 5 }] } }),
      'GET /v1/apps/ticket-board/qa': () => ({ json: { qa } }),
      'POST /v1/apps/ticket-board/qa/run': () => ({ status: 201, json: { qa: { ...qa, status: 'error', error: 'database unreachable', checks: [], passing: 0, total: 0 } } }),
    });
    expect(await api.getMetrics('ticket-board', '24h')).toMatchObject({ range: '24h', activeMembers: { total: 5 }, recent: [{ by: 'u1', status: 'blocked', args: '{}' }] });
    expect(calls[0]?.path).toBe('/v1/apps/ticket-board/metrics?range=24h');
    expect(await api.listToolCalls('ticket-board')).toEqual([{ id: 'c1', consentId: null, at: '2026-11-11T00:10:00.000Z', tool: 'tickets_list', args: '{}', result: 'error', note: null, userId: 'u1', clientName: 'Claude Desktop' }]);
    expect(await api.getQa('ticket-board')).toMatchObject({ passing: 1, total: 1, error: null, version: 'v3', checks: [{ status: 'ok', role: 'member' }] });
    expect(await api.getQa('team-wiki')).toBeNull();
    expect(await api.runQa('ticket-board')).toMatchObject({ total: 0, error: 'database unreachable' });
  });

  it('undoes a proposal decision and revokes a consent through the builder routes', async () => {
    const { api, calls } = fakeControlApi({
      'POST /v1/proposals/p1/undo': () => ({ json: { proposal: { id: 'p1', status: 'pending', run: null } } }),
      'POST /v1/apps/ticket-board/consents/c1/revoke': () => ({ json: { consent: { id: 'c1', active: false } } }),
      'GET /v1/apps': () => ({ json: { apps: [appView, { ...appView, slug: 'docs' }] } }),
      'GET /v1/apps/ticket-board/consents': () => ({ json: { consents: [{ id: 'c1', userId: 'u1', app: 'ticket-board', clientId: 'https://claude.ai/x', clientName: 'Claude Desktop', scopes: ['offline_access'], createdAt: '2026-11-11T00:00:00Z', lastUsedAt: null }] } }),
      'GET /v1/apps/docs/consents': () => ({ json: { consents: [] } }),
    });
    expect((await api.reopenProposal('p1')).proposal.state).toBe('pending');
    await api.revokeConsent('ticket-board', 'c1');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/proposals/p1/undo', 'POST /v1/apps/ticket-board/consents/c1/revoke']);
    expect(await api.listConsents()).toMatchObject([{ id: 'c1', app: 'ticket-board', client: { name: 'Claude Desktop', kind: 'claude' } }]);
  });

  it('reads a ticket’s replies and posts a new one', async () => {
    const { api, calls } = fakeControlApi({
      'GET /v1/apps/ticket-board/tickets/FB-1': () => ({
        json: { ticket: { key: 'FB-1', reporter: 'u1' }, events: [{ id: 'e1', kind: 'created', actor: 'u1', data: {} }, { id: 'e2', kind: 'reply', actor: 'b1', data: { text: 'On it.' }, createdAt: '2026-11-11T00:00:00Z' }] },
      }),
      'POST /v1/apps/ticket-board/tickets/FB-1/replies': (b) => ({ status: 201, json: { event: { id: 'e3', kind: 'reply', actor: 'b1', data: b, createdAt: '2026-11-11T00:05:00Z' } } }),
    });
    expect(await api.getTicketThread('ticket-board', 'FB-1')).toEqual([{ id: 'e2', who: 'Team · reply', text: 'On it.', at: '2026-11-11T00:00:00Z' }]);
    expect(await api.replyToTicket('ticket-board', 'FB-1', 'Fixed in v4.')).toMatchObject({ id: 'e3', text: 'Fixed in v4.' });
    expect(calls.at(-1)?.body).toEqual({ text: 'Fixed in v4.' });
  });
});
