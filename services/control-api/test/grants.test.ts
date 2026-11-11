import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, seedApp, type Harness } from './harness.ts';

let h: Harness;
let jy: string;
let other: string;

beforeAll(async () => {
  h = await createHarness();
  jy = await seedApp(h, 'jeongyun', 'ticket-board');
  await h.req('POST', '/v1/apps', { token: jy, body: { slug: 'team-wiki', name: 'Team Wiki' } });
  await h.req('POST', '/v1/apps', { token: jy, body: { slug: 'docs', name: 'Docs' } });
  other = await seedApp(h, 'sora', 'crm');
});
afterAll(() => h.close());

describe('grants', () => {
  it('runs request → allow, and request → reject, for app-to-app links', async () => {
    const req = await h.req('POST', '/v1/grants', {
      token: jy,
      body: { fromApp: 'ticket-board', toApp: 'team-wiki', kind: 'A2A', purpose: 'Write finished tickets into weekly notes' },
    });
    expect(req.status).toBe(201);
    expect(req.body.grant).toMatchObject({ fromApp: 'ticket-board', toApp: 'team-wiki', kind: 'A2A', status: 'pending', calls: 0, requestedBy: 'jeongyun' });
    const id = req.body.grant.id;

    const dup = await h.req('POST', '/v1/grants', { token: jy, body: { fromApp: 'ticket-board', toApp: 'team-wiki', kind: 'A2A', purpose: 'again' } });
    expect(dup.status).toBe(409);
    expect((await h.req('POST', '/v1/grants', { token: jy, body: { fromApp: 'docs', toApp: 'docs', kind: 'MCP', purpose: 'self' } })).status).toBe(400);

    const svc = await h.service('mcp-gateway');
    const pending = await h.req('GET', '/internal/v1/grants?fromApp=ticket-board&toApp=team-wiki', { caller: svc });
    expect(pending.body.connected).toBe(false);

    const list = await h.req('GET', '/v1/grants?status=pending', { token: jy });
    expect(list.body.grants).toEqual([expect.objectContaining({ id, fromName: 'ticket-board', toName: 'Team Wiki' })]);

    const allowed = await h.req('POST', `/v1/grants/${id}/allow`, { token: jy });
    expect(allowed.body.grant).toMatchObject({ status: 'connected', decidedBy: 'jeongyun' });
    expect((await h.req('POST', `/v1/grants/${id}/reject`, { token: jy })).status).toBe(409);

    const connected = await h.req('GET', '/internal/v1/grants?fromApp=ticket-board&toApp=team-wiki&kind=A2A', { caller: svc });
    expect(connected.body.connected).toBe(true);
    const calls = await h.req('POST', '/internal/v1/grants/calls', { caller: svc, body: { fromApp: 'ticket-board', toApp: 'team-wiki', kind: 'A2A', count: 3 } });
    expect(calls.body.grant.calls).toBe(3);
    expect((await h.req('POST', '/internal/v1/grants/calls', { caller: svc, body: { fromApp: 'docs', toApp: 'team-wiki', kind: 'MCP' } })).status).toBe(403);

    const mcp = await h.req('POST', '/v1/grants', { token: jy, body: { fromApp: 'ticket-board', toApp: 'docs', kind: 'MCP', purpose: 'Attach documents to tickets' } });
    const rejected = await h.req('POST', `/v1/grants/${mcp.body.grant.id}/reject`, { token: jy });
    expect(rejected.body.grant.status).toBe('rejected');
    // A rejected link can be requested again.
    expect((await h.req('POST', '/v1/grants', { token: jy, body: { fromApp: 'ticket-board', toApp: 'docs', kind: 'MCP', purpose: 'Try again' } })).status).toBe(201);

    const all = await h.req('GET', '/v1/grants?app=docs', { token: jy });
    expect(all.body.grants.map((g: { status: string }) => g.status)).toEqual(['pending']);
  });

  it('lets only the target app owner decide, and only source app owners request', async () => {
    const fromOther = await h.req('POST', '/v1/grants', { token: other, body: { fromApp: 'crm', toApp: 'docs', kind: 'MCP', purpose: 'Link contracts' } });
    expect(fromOther.status).toBe(201);
    const id = fromOther.body.grant.id;
    expect((await h.req('POST', `/v1/grants/${id}/allow`, { token: other })).status).toBe(403);
    expect((await h.req('GET', '/v1/grants', { token: jy })).body.grants.some((g: { id: string }) => g.id === id)).toBe(true);
    expect((await h.req('POST', `/v1/grants/${id}/allow`, { token: jy })).body.grant.status).toBe('connected');

    expect((await h.req('POST', '/v1/grants', { token: other, body: { fromApp: 'docs', toApp: 'crm', kind: 'MCP', purpose: 'not mine' } })).status).toBe(403);
    expect((await h.req('POST', '/v1/grants', { token: jy, body: { fromApp: 'docs', toApp: 'nope', kind: 'MCP', purpose: 'x' } })).status).toBe(404);
    expect((await h.req('POST', '/v1/grants/not-a-uuid/allow', { token: jy })).status).toBe(404);
  });
});
