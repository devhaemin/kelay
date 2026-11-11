import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { KelayError } from './errors.ts';
import { safeMutation, type SafeResult } from './safe.ts';
import { json, mockFetch, ticketClient, ticketRow } from './test-helpers.ts';

describe('safeMutation', () => {
  it('returns ok with the data', async () => {
    const r = await safeMutation(async () => 42);
    expect(r).toEqual({ status: 'ok', data: 42 });
    expectTypeOf(r).toEqualTypeOf<SafeResult<number>>();
  });

  it('turns a denied action into a result and calls onDenied only', async () => {
    const onDenied = vi.fn();
    const onError = vi.fn();
    const fetch = mockFetch(() => json(403, { error: { code: 'denied', message: "you can't move that ticket" } }));
    const tickets = ticketClient(fetch).collection('tickets');

    const r = await safeMutation(() => tickets.update('t2', { status: 'done' }), { onDenied, onError });

    expect(r.status).toBe('denied');
    if (r.status !== 'denied') return;
    expect(r.error.message).toBe("you can't move that ticket");
    expect(onDenied).toHaveBeenCalledWith(r.error);
    expect(onError).not.toHaveBeenCalled();
  });

  it('turns other failures into an error result and calls onError', async () => {
    const onDenied = vi.fn();
    const onError = vi.fn();
    const r = await safeMutation(() => Promise.reject(new KelayError('rate_limited', 'slow down')), { onDenied, onError });
    expect(r).toMatchObject({ status: 'error', error: { code: 'rate_limited', status: 429 } });
    expect(onError).toHaveBeenCalledOnce();
    expect(onDenied).not.toHaveBeenCalled();
  });

  it('wraps non-Kelay errors, including synchronous throws', async () => {
    const boom = new TypeError('boom');
    const r = await safeMutation(() => {
      throw boom;
    });
    expect(r).toMatchObject({ status: 'error', error: { code: 'internal', message: 'boom', cause: boom } });
  });

  it('passes the created row through', async () => {
    const tickets = ticketClient(mockFetch(() => json(200, { rows: [ticketRow()], count: 1 }))).collection('tickets');
    const r = await safeMutation(() => tickets.create({ title: 'Fix login', status: 'todo' }));
    expect(r.status === 'ok' && r.data.title).toBe('Fix login');
  });
});
