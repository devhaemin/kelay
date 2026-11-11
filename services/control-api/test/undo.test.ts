import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, seedApp, type Harness } from './harness.ts';

let h: Harness;
let builder: string;
let proposals: { id: string; refs: string[] }[];
const APP = 'ticket-board';

const ticketStatus = async (key: string) => (await h.req('GET', `/v1/apps/${APP}/tickets/${key}`, { token: builder })).body.ticket.status;
const undo = (id: string, token = builder) => h.req('POST', `/v1/proposals/${id}/undo`, { token });

beforeAll(async () => {
  h = await createHarness();
  builder = await seedApp(h, 'jeongyun', APP);
  for (const [user, text] of [['u1', 'Columns are cut off on mobile'], ['u2', 'I only want to see my tickets']] as const) {
    await h.req('POST', `/v1/apps/${APP}/feedback`, { token: await h.appUser(APP, user), caller: await h.appCaller(APP), body: { text } });
  }
  await h.req('POST', `/v1/apps/${APP}/tickets/triage`, { token: builder });
  proposals = (await h.req('POST', `/v1/apps/${APP}/reports/run`, { token: builder })).body.proposals;
});
afterAll(() => h.close());

describe('undoing a proposal decision', () => {
  it('takes back an approval whose run has not started: the run goes away and tickets return to Triaged', async () => {
    const [first] = proposals;
    const key = first!.refs[0]!;
    const approved = await h.req('POST', `/v1/proposals/${first!.id}/approve`, { token: builder });
    expect(approved.body.proposal.status).toBe('approved');
    expect(await ticketStatus(key)).toBe('progress');

    const res = await undo(first!.id);
    expect(res.status).toBe(200);
    expect(res.body.proposal).toMatchObject({ id: first!.id, status: 'pending', decidedBy: null, decidedAt: null, run: null });
    expect(await ticketStatus(key)).toBe('triaged');
    // The worker finds nothing to build.
    expect((await h.req('POST', '/internal/v1/improvement-runs/claim', { caller: await h.service('orchestrator'), body: { worker: 'w1' } })).status).toBe(204);

    const events = (await h.req('GET', `/v1/apps/${APP}/tickets/${key}`, { token: builder })).body.events;
    expect(events.at(-1)).toMatchObject({ kind: 'status', actor: 'jeongyun', data: { to: 'triaged', undo: first!.id } });

    // Undoing again changes nothing, and the proposal can be decided again.
    expect((await undo(first!.id)).body.proposal.status).toBe('pending');
    expect((await h.req('POST', `/v1/proposals/${first!.id}/reject`, { token: builder })).body.proposal.status).toBe('rejected');
  });

  it('takes back a rejection', async () => {
    const [first] = proposals;
    const res = await undo(first!.id);
    expect(res.body.proposal).toMatchObject({ status: 'pending', decidedBy: null });
    const detail = await h.req('GET', `/v1/apps/${APP}/reports/latest`, { token: builder });
    expect(detail.body.proposals.map((p: { status: string }) => p.status)).toEqual(['pending', 'pending']);
  });

  it('refuses once the improvement run has started or the change is built', async () => {
    const [, second] = proposals;
    const svc = await h.service('orchestrator');
    await h.req('POST', `/v1/proposals/${second!.id}/approve`, { token: builder });
    const claimed = await h.req('POST', '/internal/v1/improvement-runs/claim', { caller: svc, body: { worker: 'w1' } });
    const running = await undo(second!.id);
    expect(running.status).toBe(409);
    expect(running.body.error).toEqual({ code: 'conflict', message: 'the improvement run is already running' });
    expect(await ticketStatus(second!.refs[0]!)).toBe('progress');

    // A failed run built nothing, so the approval can still be taken back.
    await h.req('POST', `/internal/v1/improvement-runs/${claimed.body.run.id}/complete`, { caller: svc, body: { status: 'failed', error: 'tests failed' } });
    expect((await undo(second!.id)).body.proposal.status).toBe('pending');
    expect(await ticketStatus(second!.refs[0]!)).toBe('triaged');

    await h.req('POST', `/v1/proposals/${second!.id}/approve`, { token: builder });
    const retry = await h.req('POST', '/internal/v1/improvement-runs/claim', { caller: svc, body: { worker: 'w1' } });
    await h.req('POST', `/internal/v1/improvement-runs/${retry.body.run.id}/complete`, { caller: svc, body: { status: 'succeeded', branch: 'improve/x' } });
    const built = await undo(second!.id);
    expect(built.body.error.code).toBe('conflict');
    expect(built.body.error.message).toContain('already built');
  });

  it('is limited to the app’s owner and to proposals that exist', async () => {
    expect((await undo(proposals[0]!.id, await h.builder('stranger'))).status).toBe(403);
    expect((await undo('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await undo('nope')).status).toBe(404);
  });
});
