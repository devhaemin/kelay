import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, seedApp, type Harness } from './harness.ts';

let h: Harness;
let builder: string;
const APP = 'ticket-board';
const CLAUDE = 'https://claude.ai/oauth/mcp-client.json';
const CURSOR = 'https://cursor.com/.well-known/mcp-client.json';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const call = (over: Record<string, unknown>) => ({ type: 'mcp_call', app: APP, sub: 'mina', client: CLAUDE, tool: 'tickets_list', ms: 25, ok: true, ...over });

beforeAll(async () => {
  h = await createHarness();
  builder = await seedApp(h, 'jeongyun', APP);
  await h.req('POST', '/v1/apps', { token: builder, body: { slug: 'docs', name: 'Docs' } });
  const identity = await h.service('identity');
  for (const userId of ['mina', 'daniel', 'jiwoo']) await h.req('PUT', `/internal/v1/apps/${APP}/members/${userId}`, { caller: identity, body: { org: 'orum' } });
  await h.req('PUT', `/internal/v1/apps/${APP}/members/troll`, { caller: identity, body: { org: 'orum' } });
  await h.req('PATCH', `/v1/apps/${APP}/members/troll`, { token: builder, body: { status: 'banned' } });
  await h.req('PUT', '/internal/v1/consents', { caller: identity, body: { userId: 'mina', app: APP, clientId: CLAUDE, clientName: 'Claude Desktop', scopes: ['offline_access'] } });
});
afterAll(() => h.close());

describe('recording runs', () => {
  it('is empty but well-formed before anything ran', async () => {
    const res = await h.req('GET', `/v1/apps/${APP}/metrics`, { token: builder });
    expect(res.status).toBe(200);
    expect(res.body.metrics).toMatchObject({
      range: '24h',
      healthy: true,
      activeMembers: { value: 0, total: 3, delta: 0 },
      actionsToday: { value: 0, deltaPct: 0 },
      screenErrors7d: { value: 0, note: null },
      agentActionsToday: 0,
      llmBudgetTodayUsd: 0,
      recent: [],
    });
    expect(res.body.metrics.series.buckets).toHaveLength(24);
    expect((await h.req('GET', '/v1/apps', { token: builder })).body.apps[0].runs).toBeNull();
    expect((await h.req('GET', `/v1/apps/${APP}/tool-calls`, { token: builder })).body).toEqual({ toolCalls: [] });
  });

  it('accepts runs from platform services only and skips unknown apps', async () => {
    const runs = [
      { app: APP, action: 'tickets_update', args: 'TCK-36 → Review', userId: 'daniel', status: 'ok', ms: 90, at: ago(5 * MIN) },
      { app: APP, action: 'tickets_update', userId: 'daniel', status: 'blocked', ms: 40, at: ago(4 * MIN) },
      { app: APP, action: 'tickets_create', userId: 'jiwoo', status: 'error', ms: 300, note: 'resolution is required', at: ago(3 * MIN) },
      { app: APP, action: 'documents_get', userId: 'jiwoo', status: 'ok', ms: 310, caller: { kind: 'app', id: 'docs' }, at: ago(2 * MIN) },
      { app: APP, action: 'summarize_overdue', userId: 'mina', status: 'ok', ms: 4200, costUsd: 0.04, env: 'dev', at: ago(MIN) },
      { app: APP, action: 'tickets_list', userId: 'daniel', status: 'ok', at: ago(30 * HOUR) },
      { app: APP, action: 'tickets_list', userId: 'old-timer', status: 'ok', at: ago(9 * DAY) },
      { app: 'no-such-app', action: 'x', status: 'ok' },
    ];
    expect((await h.req('POST', '/internal/v1/runs', { token: builder, body: { runs } })).status).toBe(403);
    expect((await h.req('POST', '/internal/v1/runs', { caller: await h.appCaller(APP), body: { runs } })).status).toBe(403);
    const res = await h.req('POST', '/internal/v1/runs', { caller: await h.service('data-api'), body: { runs } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ recorded: 7, skipped: 1 });
    const bad = await h.req('POST', '/internal/v1/runs', { caller: await h.service('data-api'), body: { runs: [{ app: APP, action: 'x', status: 'fine' }] } });
    expect(bad.status).toBe(400);
  });

  it('turns MCP gateway call records into agent runs tied to the member’s consent', async () => {
    const svc = await h.service('mcp-gateway');
    const calls = [
      call({ args: '{"where":{"status":"todo"}}', at: ago(20 * MIN) }),
      call({ tool: 'tickets_delete', ok: false, denied: true, ms: 4, at: ago(10 * MIN) }),
      call({ sub: 'daniel', client: CURSOR, tool: 'tickets_get', ok: false, at: ago(8 * MIN) }),
      call({ app: 'no-such-app' }),
    ];
    const res = await h.req('POST', '/internal/v1/mcp-calls', { caller: svc, body: { calls } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ recorded: 3, skipped: 1 });
    expect((await h.req('POST', '/internal/v1/mcp-calls', { caller: svc, body: { calls: [{ ...calls[0], tool: '' }] } })).status).toBe(400);
    expect((await h.req('POST', '/internal/v1/mcp-calls', { token: builder, body: { calls } })).status).toBe(403);

    const consent = (await h.req('GET', `/v1/apps/${APP}/consents`, { token: builder })).body.consents[0];
    expect(Date.parse(consent.lastUsedAt)).toBeGreaterThan(Date.now() - 11 * MIN);
    expect(Date.parse(consent.lastUsedAt)).toBeLessThan(Date.now() - 9 * MIN);

    const list = await h.req('GET', `/v1/apps/${APP}/tool-calls`, { token: builder });
    expect(list.body.toolCalls).toEqual([
      { id: expect.any(String), consentId: null, at: expect.any(String), tool: 'tickets_get', args: '', result: 'error', note: null, userId: 'daniel', clientId: CURSOR, clientName: null, ms: 25 },
      { id: expect.any(String), consentId: consent.id, at: expect.any(String), tool: 'tickets_delete', args: '', result: 'denied', note: null, userId: 'mina', clientId: CLAUDE, clientName: 'Claude Desktop', ms: 4 },
      { id: expect.any(String), consentId: consent.id, at: expect.any(String), tool: 'tickets_list', args: '{"where":{"status":"todo"}}', result: 'ok', note: null, userId: 'mina', clientId: CLAUDE, clientName: 'Claude Desktop', ms: 25 },
    ]);
    expect((await h.req('GET', `/v1/apps/${APP}/tool-calls?limit=1`, { token: builder })).body.toolCalls).toHaveLength(1);
    expect((await h.req('GET', `/v1/apps/${APP}/tool-calls`, { token: await h.builder('stranger') })).status).toBe(403);
  });
});

describe('metrics', () => {
  it('reports KPIs over the last day and week', async () => {
    const { metrics } = (await h.req('GET', `/v1/apps/${APP}/metrics?range=24h`, { token: builder })).body;
    expect(metrics).toMatchObject({
      range: '24h',
      // 2 of 8 runs in the last 24 hours failed.
      healthy: false,
      activeMembers: { value: 3, total: 3, delta: 2 },
      actionsToday: { value: 8, deltaPct: 700 },
      screenErrors7d: { value: 1, note: null },
      agentActionsToday: 3,
      llmBudgetTodayUsd: 0.04,
    });
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(metrics.series.buckets).toHaveLength(24);
    expect(metrics.series.actions).toHaveLength(24);
    expect(sum(metrics.series.actions)).toBe(8);
    expect(sum(metrics.series.errors)).toBe(2);
    expect(metrics.series.buckets.every((b: string) => b.endsWith(':00:00.000Z'))).toBe(true);
    expect(Date.parse(metrics.series.buckets[23])).toBe(Math.floor(Date.now() / HOUR) * HOUR);
  });

  it('lists recent runs with who called: the app, a personal agent, or another app', async () => {
    const { recent } = (await h.req('GET', `/v1/apps/${APP}/metrics`, { token: builder })).body.metrics;
    expect(recent).toHaveLength(10);
    expect(recent.slice(0, 4)).toEqual([
      { id: expect.any(String), action: 'summarize_overdue', args: null, by: 'mina', status: 'ok', ms: 4200, source: 'App', caller: { kind: 'user', id: null, name: null }, env: 'dev', note: null, costUsd: 0.04, nodes: null, at: expect.any(String) },
      { id: expect.any(String), action: 'documents_get', args: null, by: 'jiwoo', status: 'ok', ms: 310, source: 'Docs', caller: { kind: 'app', id: 'docs', name: 'Docs' }, env: 'prod', note: null, costUsd: 0, nodes: null, at: expect.any(String) },
      { id: expect.any(String), action: 'tickets_create', args: null, by: 'jiwoo', status: 'error', ms: 300, source: 'App', caller: { kind: 'user', id: null, name: null }, env: 'prod', note: 'resolution is required', costUsd: 0, nodes: null, at: expect.any(String) },
      { id: expect.any(String), action: 'tickets_update', args: null, by: 'daniel', status: 'blocked', ms: 40, source: 'App', caller: { kind: 'user', id: null, name: null }, env: 'prod', note: null, costUsd: 0, nodes: null, at: expect.any(String) },
    ]);
    const agent = recent.find((x: { action: string }) => x.action === 'tickets_delete');
    expect(agent).toMatchObject({ by: 'mina', status: 'blocked', source: 'Claude Desktop (MCP)', caller: { kind: 'agent', id: CLAUDE, name: 'Claude Desktop' } });
    expect(recent.find((x: { action: string }) => x.action === 'tickets_get').source).toBe(`${CURSOR} (MCP)`);
  });

  it('buckets by UTC day for 14d and 30d, and filters by env', async () => {
    const d14 = (await h.req('GET', `/v1/apps/${APP}/metrics?range=14d`, { token: builder })).body.metrics;
    expect(d14.range).toBe('14d');
    expect(d14.series.buckets).toHaveLength(14);
    expect(d14.series.actions.reduce((a: number, b: number) => a + b, 0)).toBe(10);
    expect(Date.parse(d14.series.buckets[13])).toBe(Math.floor(Date.now() / DAY) * DAY);
    const d30 = (await h.req('GET', `/v1/apps/${APP}/metrics?range=30d`, { token: builder })).body.metrics;
    expect(d30.series.errors).toHaveLength(30);

    const dev = (await h.req('GET', `/v1/apps/${APP}/metrics?env=dev`, { token: builder })).body.metrics;
    expect(dev).toMatchObject({ actionsToday: { value: 1 }, agentActionsToday: 0, healthy: true });
    expect(dev.recent.map((x: { action: string }) => x.action)).toEqual(['summarize_overdue']);

    expect((await h.req('GET', `/v1/apps/${APP}/metrics?range=1y`, { token: builder })).status).toBe(400);
    expect((await h.req('GET', `/v1/apps/${APP}/metrics`, { token: await h.builder('stranger') })).status).toBe(403);
    expect((await h.req('GET', '/v1/apps', { token: builder })).body.apps.find((a: { slug: string }) => a.slug === APP).runs).toBe(10);
  });
});

describe('agent-graph runs from the run orchestrator', () => {
  it('keeps per-node metrics and model cost, and names the assistant from the member’s consent', async () => {
    const nodes = [
      { node: 'collect', status: 'ok', ms: 40, attempt: 1, loop: 0 },
      { node: 'summarize', status: 'ok', ms: 900, attempt: 1, loop: 0, costUsd: 0.012 },
      { node: 'prioritize', status: 'error', ms: 300, attempt: 1, loop: 0 },
    ];
    const run = { app: APP, action: 'summarize_overdue', userId: 'mina', status: 'error', ms: 1300, costUsd: 0.012, note: 'prioritize: TypeError: no tickets', nodes, caller: { kind: 'agent', id: CLAUDE } };
    const runner = await h.service('runner');
    expect((await h.req('POST', '/internal/v1/runs', { caller: runner, body: { runs: [run, { ...run, userId: 'daniel', caller: { kind: 'app', id: 'docs' }, nodes: undefined }] } })).body).toEqual({ recorded: 2, skipped: 0 });
    expect((await h.req('POST', '/internal/v1/runs', { caller: runner, body: { runs: [{ ...run, nodes: [{ node: 'collect', status: 'fine', ms: 1 }] }] } })).status).toBe(400);

    const { recent } = (await h.req('GET', `/v1/apps/${APP}/metrics`, { token: builder })).body.metrics;
    const byAgent = recent.find((x: { action: string; caller: { kind: string } }) => x.action === 'summarize_overdue' && x.caller.kind === 'agent');
    expect(byAgent).toMatchObject({ by: 'mina', status: 'error', ms: 1300, costUsd: 0.012, nodes, source: 'Claude Desktop (MCP)', caller: { kind: 'agent', id: CLAUDE, name: 'Claude Desktop' } });
    const byApp = recent.find((x: { action: string; caller: { kind: string } }) => x.action === 'summarize_overdue' && x.caller.kind === 'app');
    expect(byApp).toMatchObject({ by: 'daniel', nodes: null, source: 'Docs' });

    const consent = (await h.req('GET', `/v1/apps/${APP}/consents`, { token: builder })).body.consents[0];
    const calls = (await h.req('GET', `/v1/apps/${APP}/tool-calls`, { token: builder })).body.toolCalls;
    expect(calls[0]).toMatchObject({ tool: 'summarize_overdue', consentId: consent.id, clientName: 'Claude Desktop', result: 'error' });
  });
});
