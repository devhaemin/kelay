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

  it('surfaces Control API errors and treats missing provisional reads as unavailable', async () => {
    const { api } = fakeControlApi({
      'POST /v1/grants/g1/allow': () => ({ status: 403, json: { error: { code: 'denied', message: 'only the target app’s owner can decide' } } }),
    });
    await expect(api.allowGrant('g1')).rejects.toMatchObject({ code: 'denied', status: 403, message: 'only the target app’s owner can decide' });
    expect(await api.getMetrics('ticket-board', '14d')).toBeNull();
    expect(await api.getBuilderThread('ticket-board', 'screen')).toEqual([]);
  });
});
