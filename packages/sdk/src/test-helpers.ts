// Shared by the SDK tests. Mirrors packages/contracts/fixtures/ticket-board/schema.json, written
// inline because JSON imports lose the literal types the inference tests need.
import { vi, type Mock } from 'vitest';
import { createKelayClient } from './client.ts';
import { defineApp } from './define.ts';

export const ticketBoard = defineApp({
  app: 'ticket-board',
  roles: ['admin', 'member', 'guest'],
  collections: [
    {
      name: 'projects',
      label: 'Projects',
      fields: { name: { type: 'text', required: true }, starts_on: { type: 'timestamp' }, ends_on: { type: 'timestamp' } },
    },
    {
      name: 'tickets',
      label: 'Tickets',
      shared: true,
      ownerField: 'assignee_id',
      fields: {
        title: { type: 'text', required: true },
        status: { type: 'text', required: true, description: 'todo | doing | review | done' },
        assignee_id: { type: 'text' },
        due_on: { type: 'timestamp' },
        project_id: { type: 'ref', ref: 'projects' },
      },
    },
    {
      name: 'comments',
      label: 'Comments',
      fields: { ticket_id: { type: 'ref', ref: 'tickets', required: true }, body: { type: 'text', required: true } },
    },
  ],
  actions: [{ name: 'summarize_overdue', description: 'Summarize my overdue tickets', input: {}, graph: 'overdue-summary' }],
});

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const ticketRow = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  org_id: 'orum',
  owner_id: 'u_alice',
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
  shared: false,
  title: 'Fix login',
  status: 'todo',
  assignee_id: 'u_alice',
  due_on: null,
  project_id: null,
  ...over,
});

export type FetchMock = Mock<typeof fetch>;

/** A fetch that answers each call with the next response (the last one repeats). */
export function mockFetch(...responses: (() => Response | Promise<Response>)[]): FetchMock {
  let i = 0;
  return vi.fn<typeof fetch>(async () => {
    const next = responses[Math.min(i++, responses.length - 1)];
    if (!next) throw new Error('mockFetch: no responses configured');
    return next();
  });
}

export function sentRequest(fetch: FetchMock, call = -1) {
  const args = fetch.mock.calls.at(call);
  if (!args) throw new Error('fetch was not called');
  const [url, init] = args;
  return {
    url: String(url),
    method: init?.method,
    headers: init?.headers as Record<string, string>,
    body: JSON.parse(String(init?.body)) as unknown,
  };
}

export const auth = { getUserToken: () => 'user-tok', getCallerToken: async () => 'caller-tok' };

export const ticketClient = (fetch: FetchMock) =>
  createKelayClient({ dataApiUrl: 'http://localhost:4002/', app: ticketBoard, fetch, ...auth });
