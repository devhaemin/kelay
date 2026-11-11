import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKelayClient } from './client.ts';
import { KelayError } from './errors.ts';
import { auth, json, mockFetch, sentRequest, ticketClient, ticketRow } from './test-helpers.ts';

const ok = (rows: unknown[]) => () => json(200, { rows, count: rows.length });
const fail = (status: number, code: string, message = `${code} message`) => () => json(status, { error: { code, message } });

async function rejection(p: Promise<unknown>): Promise<KelayError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KelayError);
    return e as KelayError;
  }
  throw new Error('expected a rejection');
}

describe('createKelayClient requests (contract §5)', () => {
  it('lists with where, orderBy, limit and offset, and sends both tokens', async () => {
    const fetch = mockFetch(ok([ticketRow()]));
    const rows = await ticketClient(fetch)
      .collection('tickets')
      .list({ where: { status: { in: ['todo', 'doing'] }, assignee_id: 'u_alice' }, orderBy: [{ field: 'due_on', dir: 'asc' }], limit: 10, offset: 20 });
    expect(rows).toEqual([ticketRow()]);
    const req = sentRequest(fetch);
    expect(req.url).toBe('http://localhost:4002/v1/apps/ticket-board/query');
    expect(req.method).toBe('POST');
    expect(req.headers).toMatchObject({
      authorization: 'Bearer user-tok',
      'x-kelay-caller': 'caller-tok',
      'content-type': 'application/json',
    });
    expect(req.body).toEqual({
      op: 'select',
      collection: 'tickets',
      where: { status: { in: ['todo', 'doing'] }, assignee_id: 'u_alice' },
      orderBy: [{ field: 'due_on', dir: 'asc' }],
      limit: 10,
      offset: 20,
    });
  });

  it('gets one row by id, or null', async () => {
    const fetch = mockFetch(ok([ticketRow()]), ok([]));
    const tickets = ticketClient(fetch).collection('tickets');
    expect(await tickets.get('t1')).toEqual(ticketRow());
    expect(sentRequest(fetch).body).toEqual({ op: 'select', collection: 'tickets', where: { id: 't1' }, limit: 1 });
    expect(await tickets.get('missing')).toBeNull();
  });

  it('creates, updates and removes', async () => {
    const fetch = mockFetch(ok([ticketRow()]), ok([ticketRow({ status: 'done' })]), ok([]), () => json(200, { rows: [ticketRow()], count: 1 }), ok([]));
    const tickets = ticketClient(fetch).collection('tickets');

    expect(await tickets.create({ title: 'Fix login', status: 'todo', shared: true })).toEqual(ticketRow());
    expect(sentRequest(fetch).body).toEqual({ op: 'insert', collection: 'tickets', values: { title: 'Fix login', status: 'todo', shared: true } });

    expect(await tickets.update('t1', { status: 'done' })).toMatchObject({ status: 'done' });
    expect(sentRequest(fetch).body).toEqual({ op: 'update', collection: 'tickets', where: { id: 't1' }, values: { status: 'done' } });
    expect(await tickets.update('gone', { status: 'done' })).toBeNull();

    expect(await tickets.remove('t1')).toBe(true);
    expect(sentRequest(fetch).body).toEqual({ op: 'delete', collection: 'tickets', where: { id: 't1' } });
    expect(await tickets.remove('t1')).toBe(false);
  });

  it('sends raw queries and works with a slug-only app', async () => {
    const fetch = mockFetch(ok([{ id: 'x' }]));
    const client = createKelayClient({ dataApiUrl: 'http://data', app: 'wiki', fetch, ...auth });
    expect(await client.query({ op: 'select', collection: 'pages', limit: 1 })).toEqual({ rows: [{ id: 'x' }], count: 1 });
    expect(sentRequest(fetch).url).toBe('http://data/v1/apps/wiki/query');
    expect(client.app).toBe('wiki');
  });

  it('falls back to the global fetch', async () => {
    const global = mockFetch(ok([]));
    vi.stubGlobal('fetch', global);
    await createKelayClient({ dataApiUrl: 'http://data', app: 'wiki', ...auth }).collection('pages').list();
    expect(global).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

describe('createKelayClient errors', () => {
  it('maps a denied response to KelayError.isDenied()', async () => {
    const fetch = mockFetch(fail(403, 'denied', "you can't move that ticket"));
    const e = await rejection(ticketClient(fetch).collection('tickets').update('t2', { status: 'done' }));
    expect(e).toMatchObject({ code: 'denied', status: 403, message: "you can't move that ticket" });
    expect(e.isDenied()).toBe(true);
  });

  it.each([
    [401, 'unauthenticated'],
    [403, 'forbidden_caller'],
    [404, 'unknown_collection'],
    [429, 'rate_limited'],
    [500, 'internal'],
  ])('keeps the contract code from a %i body (%s)', async (status, code) => {
    const e = await rejection(ticketClient(mockFetch(fail(status, code))).collection('tickets').list());
    expect(e).toMatchObject({ code, status });
    expect(e.isDenied()).toBe(false);
  });

  it('falls back to a code from the status when the body is not a contract error', async () => {
    const plain = (status: number, body: string) => () => new Response(body, { status });
    const list = (status: number, body: string) => rejection(ticketClient(mockFetch(plain(status, body))).collection('tickets').list());
    expect(await list(502, '<html>bad gateway</html>')).toMatchObject({ code: 'internal', status: 502 });
    expect(await list(403, '')).toMatchObject({ code: 'denied', status: 403 });
    expect(await list(404, '{"error":{"code":"nope"}}')).toMatchObject({ code: 'unknown_app', status: 404 });
  });

  it('reports network failures as code network with status 0', async () => {
    const fetch = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await rejection(ticketClient(fetch).collection('tickets').list())).toMatchObject({ code: 'network', status: 0 });
  });

  it('reports a failing token getter as unauthenticated without calling fetch', async () => {
    const fetch = mockFetch(ok([]));
    const client = createKelayClient({
      dataApiUrl: 'http://data',
      app: 'wiki',
      fetch,
      getUserToken: () => Promise.reject(new Error('signed out')),
      getCallerToken: () => 'c',
    });
    expect(await rejection(client.collection('pages').list())).toMatchObject({ code: 'unauthenticated', status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid queries and unknown collections before sending', async () => {
    const fetch = mockFetch(ok([]));
    const client = ticketClient(fetch);
    expect(await rejection(client.query({ op: 'select', collection: 'tickets; drop table x' }))).toMatchObject({ code: 'invalid_request' });
    expect(await rejection(client.query({ op: 'select', collection: 'wiki' }))).toMatchObject({ code: 'unknown_collection', status: 404 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed success response', async () => {
    const e = await rejection(ticketClient(mockFetch(() => json(200, { data: [] }))).collection('tickets').list());
    expect(e.code).toBe('internal');
  });

  it('refuses an invalid app slug', () => {
    expect(() => createKelayClient({ dataApiUrl: 'http://data', app: 'Not A Slug', ...auth })).toThrow(KelayError);
  });
});
