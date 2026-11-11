import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, seedApp, type Harness } from './harness.ts';

let h: Harness;
let builder: string;
const APP = 'ticket-board';

async function feedback(user: string, text: string, extra: Record<string, unknown> = {}) {
  const res = await h.req('POST', `/v1/apps/${APP}/feedback`, {
    token: await h.appUser(APP, user),
    caller: await h.appCaller(APP),
    body: { text, ...extra },
  });
  expect(res.status).toBe(201);
  return res.body.ticketId as string;
}

beforeAll(async () => {
  h = await createHarness();
  builder = await seedApp(h, 'jeongyun', APP);
});
afterAll(() => h.close());

describe('feedback intake', () => {
  it('turns /feedback into a New ticket and returns { ticketId }', async () => {
    const res = await h.req('POST', `/v1/apps/${APP}/feedback`, {
      token: await h.appUser(APP, 'u1'),
      caller: await h.appCaller(APP),
      body: { text: 'I only want to see my tickets', route: '/board', context: { viewer: 'mina' } },
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ticketId: 'FB-1' });

    const t = await h.req('GET', `/v1/apps/${APP}/tickets/FB-1`, { token: builder });
    expect(t.body.ticket).toMatchObject({
      key: 'FB-1',
      title: 'I only want to see my tickets',
      text: 'I only want to see my tickets',
      route: '/board',
      context: { viewer: 'mina' },
      source: 'in-app',
      status: 'new',
      votes: 1,
      reporter: 'u1',
      reporterOrg: 'orum',
      type: null,
      valid: null,
    });
    expect(t.body.events).toEqual([expect.objectContaining({ kind: 'created', actor: 'u1', data: { source: 'in-app', env: 'prod' } })]);
    expect((await h.req('GET', '/v1/apps', { token: builder })).body.apps[0].newFeedback).toBe(1);
  });

  it('validates the body and refuses banned members and unknown apps', async () => {
    const token = await h.appUser(APP, 'u9');
    const caller = await h.appCaller(APP);
    expect((await h.req('POST', `/v1/apps/${APP}/feedback`, { token, caller, body: { text: '   ' } })).status).toBe(400);

    await h.req('PUT', `/internal/v1/apps/${APP}/members/u9`, { caller: await h.service('identity'), body: { org: 'orum' } });
    await h.req('PATCH', `/v1/apps/${APP}/members/u9`, { token: builder, body: { status: 'banned' } });
    const banned = await h.req('POST', `/v1/apps/${APP}/feedback`, { token, caller, body: { text: 'let me in' } });
    expect(banned.status).toBe(403);

    const ghost = await h.req('POST', '/v1/apps/ghost-app/feedback', {
      token: await h.appUser('ghost-app', 'u1'),
      caller: await h.appCaller('ghost-app'),
      body: { text: 'hello' },
    });
    expect(ghost.status).toBe(404);
  });

  it('takes email, chat and auto-detected feedback from platform services', async () => {
    const res = await h.req('POST', `/internal/v1/apps/${APP}/feedback`, {
      caller: await h.service('telemetry'),
      body: { text: 'Error spike: moving a ticket to Done fails for 3 users', source: 'auto' },
    });
    expect(res.status).toBe(201);
    expect(res.body.ticketId).toBe('FB-2');
  });
});

describe('triage', () => {
  it('classifies new tickets, merges duplicates with a vote, and filters noise', async () => {
    await feedback('u2', 'Can I only see my own tickets?');
    await feedback('u3', 'The board is so slow with lots of tickets');
    await feedback('u4', 'asdf');
    await feedback('u4', "Columns are cut off on mobile, can't tell what's in Done");

    const res = await h.req('POST', `/v1/apps/${APP}/tickets/triage`, { token: builder });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ processed: 6, triaged: 4, duplicates: 1, noise: 1, failed: 0 });
    const byKey = Object.fromEntries(res.body.tickets.map((t: { key: string }) => [t.key, t]));
    expect(byKey['FB-1']).toMatchObject({ outcome: 'triaged', type: 'feat', priority: 'med' });
    expect(byKey['FB-2']).toMatchObject({ outcome: 'triaged', type: 'bug', priority: 'high' });
    expect(byKey['FB-3']).toMatchObject({ outcome: 'duplicate', duplicateOf: 'FB-1' });
    expect(byKey['FB-3'].similarity).toBeGreaterThan(0.45);
    expect(byKey['FB-4']).toMatchObject({ outcome: 'triaged', type: 'quality' });
    expect(byKey['FB-5']).toMatchObject({ outcome: 'noise' });
    expect(byKey['FB-6']).toMatchObject({ outcome: 'triaged', type: 'ux' });
    // Duplicates are found with pg_trgm before any model call.
    expect(h.llm.triageCalls.map((c) => c.key)).toEqual(['FB-1', 'FB-2', 'FB-4', 'FB-5', 'FB-6']);

    const original = await h.req('GET', `/v1/apps/${APP}/tickets/FB-1`, { token: builder });
    expect(original.body.ticket).toMatchObject({ status: 'triaged', votes: 2, valid: true, title: 'Wish: I only want to see my tickets' });
    expect(original.body.duplicates).toEqual(['FB-3']);
    expect(original.body.events.map((e: { kind: string }) => e.kind)).toEqual(['created', 'triaged', 'vote']);

    const dup = await h.req('GET', `/v1/apps/${APP}/tickets/FB-3`, { token: builder });
    expect(dup.body.ticket).toMatchObject({ status: 'triaged', duplicateOf: 'FB-1', type: 'feat', priority: 'med' });

    const again = await h.req('POST', `/v1/apps/${APP}/tickets/triage`, { token: builder });
    expect(again.body.processed).toBe(0);
  });

  it('merges a later report into the triaged ticket', async () => {
    await feedback('u6', 'i only want to see my tickets please');
    const res = await h.req('POST', `/v1/apps/${APP}/tickets/triage`, { caller: await h.service('scheduler') });
    expect(res.body.tickets).toEqual([expect.objectContaining({ key: 'FB-7', outcome: 'duplicate', duplicateOf: 'FB-1' })]);
    expect((await h.req('GET', `/v1/apps/${APP}/tickets/FB-1`, { token: builder })).body.ticket.votes).toBe(3);
  });

  it('keeps a ticket New when the model call fails', async () => {
    h.llm.failOn = 'pricing';
    await feedback('u7', 'Show pricing per seat');
    const res = await h.req('POST', `/v1/apps/${APP}/tickets/triage`, { token: builder });
    expect(res.body).toMatchObject({ processed: 1, failed: 1 });
    expect((await h.req('GET', `/v1/apps/${APP}/tickets/FB-8`, { token: builder })).body.ticket.status).toBe('new');
    h.llm.failOn = null;
    expect((await h.req('POST', `/v1/apps/${APP}/tickets/triage`, { token: builder })).body.triaged).toBe(1);
  });
});

describe('ticket board', () => {
  it('lists open tickets by default and everything with include=all', async () => {
    const open = await h.req('GET', `/v1/apps/${APP}/tickets`, { token: builder });
    expect(open.body.tickets.map((t: { key: string }) => t.key).sort()).toEqual(['FB-1', 'FB-2', 'FB-4', 'FB-6', 'FB-8']);
    expect(open.body.total).toBe(5);

    const all = await h.req('GET', `/v1/apps/${APP}/tickets?include=all`, { token: builder });
    expect(all.body.total).toBe(8);
    expect(all.body.tickets.find((t: { key: string }) => t.key === 'FB-7').duplicateOf).toBe('FB-1');

    const bugs = await h.req('GET', `/v1/apps/${APP}/tickets?type=bug`, { token: builder });
    expect(bugs.body.tickets.map((t: { key: string }) => t.key)).toEqual(['FB-2']);
    const search = await h.req('GET', `/v1/apps/${APP}/tickets?q=mobile`, { token: builder });
    expect(search.body.tickets.map((t: { key: string }) => t.key)).toEqual(['FB-6']);
    expect((await h.req('GET', `/v1/apps/${APP}/tickets?status=nope`, { token: builder })).status).toBe(400);
  });

  it('updates, merges and replies to tickets', async () => {
    const moved = await h.req('PATCH', `/v1/apps/${APP}/tickets/FB-2`, { token: builder, body: { status: 'done', fixedIn: 'v12' } });
    expect(moved.body.ticket).toMatchObject({ status: 'done', fixedIn: 'v12' });

    const merged = await h.req('PATCH', `/v1/apps/${APP}/tickets/FB-8`, { token: builder, body: { duplicateOf: 'FB-4' } });
    expect(merged.body.ticket.duplicateOf).toBe('FB-4');
    expect((await h.req('GET', `/v1/apps/${APP}/tickets/FB-4`, { token: builder })).body.ticket.votes).toBe(2);
    expect((await h.req('PATCH', `/v1/apps/${APP}/tickets/FB-4`, { token: builder, body: { duplicateOf: 'FB-4' } })).status).toBe(400);
    expect((await h.req('PATCH', `/v1/apps/${APP}/tickets/FB-4`, { token: builder, body: { duplicateOf: 'FB-8' } })).status).toBe(400);

    const reply = await h.req('POST', `/v1/apps/${APP}/tickets/FB-1/replies`, { token: builder, body: { text: 'Shipping this in v13.' } });
    expect(reply.status).toBe(201);
    expect((await h.req('GET', `/v1/apps/${APP}/tickets/FB-1`, { token: builder })).body.ticket.replies).toBe(1);
    expect((await h.req('GET', `/v1/apps/${APP}/tickets/FB-404`, { token: builder })).status).toBe(404);
  });
});
