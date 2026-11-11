// @vitest-environment happy-dom
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createKelayClient } from './client.ts';
import { KelayProvider, useCollection, useMutation } from './react.ts';
import type { SafeResult } from './safe.ts';
import { auth, json, ticketBoard, ticketRow } from './test-helpers.ts';
import type { Row } from './types.ts';

declare module './index.ts' {
  interface Register {
    app: typeof ticketBoard;
  }
}

type Ticket = Row<typeof ticketBoard, 'tickets'>;

const denied = { error: { code: 'denied', message: "you can't move that ticket" } };

/** A tiny Data API: one ticket per id in `tickets`; t2 belongs to someone else. */
function setup(options: { readDenied?: boolean } = {}) {
  const tickets = new Map([['t1', ticketRow()]]);
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.op === 'select') {
      if (options.readDenied) return json(403, denied);
      return json(200, { rows: [...tickets.values()], count: tickets.size });
    }
    if (body.op === 'update' && body.where.id === 't2') return json(403, denied);
    if (body.op === 'update') {
      const row = { ...tickets.get(body.where.id), ...body.values };
      tickets.set(body.where.id, row);
      return json(200, { rows: [row], count: 1 });
    }
    return json(400, { error: { code: 'invalid_request', message: 'unexpected' } });
  });
  const client = createKelayClient({ dataApiUrl: 'http://data', app: ticketBoard, fetch, ...auth });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(KelayProvider, { client, queryClient }, children);
  return { fetch, wrapper };
}

afterEach(cleanup);

describe('useCollection', () => {
  it('loads typed rows', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCollection('tickets', { where: { status: 'todo' } }), { wrapper });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toEqual([ticketRow()]);
    expect(result.current.denied).toBe(false);
    expectTypeOf(result.current.rows).toEqualTypeOf<Ticket[]>();
  });

  it('surfaces a denied read as state instead of throwing', async () => {
    const { wrapper } = setup({ readDenied: true });
    const { result } = renderHook(() => useCollection('tickets'), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ rows: [], denied: true, error: { code: 'denied' } });
  });
});

describe('useMutation', () => {
  it('resolves a denied action as a result, sets denied, and calls onDenied', async () => {
    const { wrapper } = setup();
    const onDenied = vi.fn();
    const { result } = renderHook(
      () => useMutation((kelay, id: string) => kelay.collection('tickets').update(id, { status: 'done' }), { onDenied }),
      { wrapper },
    );
    let outcome: SafeResult<Ticket | null> | undefined;
    await act(async () => {
      outcome = await result.current.mutate('t2');
    });
    expect(outcome?.status).toBe('denied');
    expect(onDenied).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.denied).toBe(true));
    expect(result.current.error?.message).toBe("you can't move that ticket");
  });

  it('refetches collections after a successful mutation', async () => {
    const { wrapper, fetch } = setup();
    const { result } = renderHook(
      () => ({
        list: useCollection('tickets'),
        move: useMutation((kelay, id: string, status: string) => kelay.collection('tickets').update(id, { status }), {
          invalidates: ['tickets'],
        }),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.list.rows).toHaveLength(1));

    let outcome: SafeResult<Ticket | null> | undefined;
    await act(async () => {
      outcome = await result.current.move.mutate('t1', 'done');
    });
    expect(outcome).toMatchObject({ status: 'ok', data: { status: 'done' } });
    await waitFor(() => expect(result.current.list.rows[0]?.status).toBe('done'));
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).op)).toEqual(['select', 'update', 'select']);
  });
});
