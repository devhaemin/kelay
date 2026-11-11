import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { IMPROVEMENT_CHANNEL } from '../src/queue/improvement.ts';
import { createHarness, seedApp, type Harness } from './harness.ts';

let h: Harness;
let builder: string;
const APP = 'ticket-board';

beforeAll(async () => {
  h = await createHarness();
  builder = await seedApp(h, 'jeongyun', APP);
});
afterAll(() => h.close());

async function feedback(user: string, text: string) {
  await h.req('POST', `/v1/apps/${APP}/feedback`, { token: await h.appUser(APP, user), caller: await h.appCaller(APP), body: { text } });
}

describe('daily report', () => {
  it('writes an empty report without calling the model when nothing is open', async () => {
    const res = await h.req('POST', `/v1/apps/${APP}/reports/run`, { token: builder });
    expect(res.status).toBe(201);
    expect(res.body.proposals).toEqual([]);
    expect(res.body.report.stats).toMatchObject({ received: 0, open: 0 });
    expect(h.llm.reportCalls).toHaveLength(0);
  });

  it('summarizes open tickets and metrics into proposals with ticket refs', async () => {
    await feedback('u1', 'I only want to see my tickets');
    await feedback('u2', 'Can I only see my own tickets?');
    await feedback('u3', 'Columns are cut off on mobile');
    await feedback('u4', 'asdf');
    await h.req('POST', `/v1/apps/${APP}/tickets/triage`, { token: builder });

    const res = await h.req('POST', `/v1/apps/${APP}/reports/run`, {
      caller: await h.service('scheduler'),
      body: { date: '2026-11-11', metrics: { activeMembers7d: 11, actionsToday: 210, screenErrors7d: 0 } },
    });
    expect(res.status).toBe(201);
    const { report, proposals } = res.body;
    expect(report).toMatchObject({ app: APP, date: '2026-11-11', summary: '2 open tickets; the top one is FB-1.' });
    expect(report.stats).toMatchObject({
      received: 4,
      valid: 2,
      mergedOrNoise: 2,
      open: 2,
      byType: { feat: 1, ux: 1 },
      metrics: { activeMembers7d: 11, actionsToday: 210, screenErrors7d: 0 },
    });

    const call = h.llm.reportCalls[0]!;
    expect(call.tickets.map((t) => t.key)).toEqual(['FB-1', 'FB-3']);
    expect(call.tickets[0]).toMatchObject({ votes: 2, type: 'feat' });

    expect(proposals).toHaveLength(2);
    // Unknown ticket keys from the model are dropped.
    expect(proposals[0]).toMatchObject({ position: 1, refs: ['FB-1'], impact: 'High', effort: 'S', affects: 'board screen', status: 'pending' });
    expect(proposals[1]).toMatchObject({ position: 2, refs: ['FB-3'], impact: 'Med', effort: 'M' });
  });

  it('lists reports and serves the latest with its proposals', async () => {
    const list = await h.req('GET', `/v1/apps/${APP}/reports`, { token: builder });
    expect(list.body.reports).toHaveLength(2);
    expect(list.body.reports[0].proposals).toEqual({ pending: 2 });

    const latest = await h.req('GET', `/v1/apps/${APP}/reports/latest`, { token: builder });
    expect(latest.body.report.date).toBe('2026-11-11');
    expect(latest.body.proposals.map((p: { title: string }) => p.title)).toEqual(['Fix Wish: I only want to see my tickets', 'Improve UX: Columns are cut off on mobile']);

    const byId = await h.req('GET', `/v1/apps/${APP}/reports/${latest.body.report.id}`, { token: builder });
    expect(byId.body.report.id).toBe(latest.body.report.id);
    expect((await h.req('GET', `/v1/apps/${APP}/reports/not-a-uuid`, { token: builder })).status).toBe(404);
    expect((await h.req('GET', `/v1/apps/${APP}/reports/latest`, { token: await h.builder('stranger') })).status).toBe(403);
  });
});

describe('proposal decisions', () => {
  it('approve queues an improvement run and moves the referenced tickets to In progress', async () => {
    const latest = await h.req('GET', `/v1/apps/${APP}/reports/latest`, { token: builder });
    const [first, second] = latest.body.proposals;

    const listener = new pg.Client({ connectionString: h.databaseUrl });
    await listener.connect();
    const notified = new Promise<string>((resolve) => listener.on('notification', (n) => resolve(n.payload ?? '')));
    await listener.query(`listen ${IMPROVEMENT_CHANNEL}`);

    const stranger = await h.builder('stranger');
    expect((await h.req('POST', `/v1/proposals/${first.id}/approve`, { token: stranger })).status).toBe(403);

    const res = await h.req('POST', `/v1/proposals/${first.id}/approve`, { token: builder });
    expect(res.status).toBe(200);
    expect(res.body.proposal).toMatchObject({ status: 'approved', decidedBy: 'jeongyun' });
    expect(res.body.run).toMatchObject({ proposalId: first.id, app: APP, status: 'queued' });
    expect(h.queue.enqueued.map((r) => r.id)).toEqual([res.body.run.id]);
    expect(await notified).toBe(res.body.run.id);
    await listener.end();

    const ticket = await h.req('GET', `/v1/apps/${APP}/tickets/FB-1`, { token: builder });
    expect(ticket.body.ticket.status).toBe('progress');

    const again = await h.req('POST', `/v1/proposals/${first.id}/approve`, { token: builder });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('conflict');

    const rejected = await h.req('POST', `/v1/proposals/${second.id}/reject`, { token: builder });
    expect(rejected.body.proposal.status).toBe('rejected');
    expect((await h.req('POST', `/v1/proposals/${second.id}/approve`, { token: builder })).status).toBe(409);
    expect((await h.req('POST', '/v1/proposals/00000000-0000-4000-8000-000000000000/approve', { token: builder })).status).toBe(404);

    const report = await h.req('GET', `/v1/apps/${APP}/reports/latest`, { token: builder });
    expect(report.body.proposals[0].run).toMatchObject({ id: res.body.run.id, status: 'queued' });
  });

  it('workers claim queued runs once and completing one marks the proposal built', async () => {
    const svc = await h.service('sandbox-orchestrator');
    const claimed = await h.req('POST', '/internal/v1/improvement-runs/claim', { caller: svc, body: { worker: 'w1' } });
    expect(claimed.status).toBe(200);
    expect(claimed.body.run).toMatchObject({ status: 'running', worker: 'w1' });
    expect(claimed.body.proposal.refs).toEqual(['FB-1']);
    expect((await h.req('POST', '/internal/v1/improvement-runs/claim', { caller: svc, body: { worker: 'w2' } })).status).toBe(204);

    const done = await h.req('POST', `/internal/v1/improvement-runs/${claimed.body.run.id}/complete`, {
      caller: svc,
      body: { status: 'succeeded', branch: 'improve/members-see-own-tickets' },
    });
    expect(done.body.run).toMatchObject({ status: 'succeeded', branch: 'improve/members-see-own-tickets' });
    const report = await h.req('GET', `/v1/apps/${APP}/reports/latest`, { token: builder });
    expect(report.body.proposals[0]).toMatchObject({ status: 'built', run: { status: 'succeeded' } });
    expect((await h.req('POST', `/internal/v1/improvement-runs/${claimed.body.run.id}/complete`, { caller: svc, body: { status: 'failed' } })).status).toBe(409);
  });
});
