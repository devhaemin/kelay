import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createKelayClient } from './client.ts';
import { defineApp, defineGraph, definePolicy } from './define.ts';
import { KelayError } from './errors.ts';
import { auth, mockFetch, ticketBoard } from './test-helpers.ts';
import type { AnyRow, CollectionName, NewRow, Row, RowPatch } from './types.ts';

type App = typeof ticketBoard;

const fx = (p: string) =>
  JSON.parse(readFileSync(createRequire(import.meta.url).resolve(`@kelay/contracts/fixtures/${p}`), 'utf8'));

describe('row type inference', () => {
  it('infers ticket rows with implicit columns, shared, and optional fields', () => {
    expectTypeOf<Row<App, 'tickets'>>().toEqualTypeOf<{
      id: string;
      org_id: string;
      owner_id: string;
      created_at: string;
      updated_at: string;
      shared: boolean;
      title: string;
      status: string;
      assignee_id?: string | null;
      due_on?: string | null;
      project_id?: string | null;
    }>();
  });

  it('adds shared only to shared collections', () => {
    expectTypeOf<Row<App, 'projects'>>().not.toHaveProperty('shared');
    expectTypeOf<Row<App, 'comments'>>().toEqualTypeOf<{
      id: string;
      org_id: string;
      owner_id: string;
      created_at: string;
      updated_at: string;
      ticket_id: string;
      body: string;
    }>();
  });

  it('maps every field type', () => {
    const app = defineApp({
      app: 'types',
      roles: ['admin'],
      collections: [
        {
          name: 'things',
          fields: {
            t: { type: 'text', required: true },
            n: { type: 'number', required: true },
            b: { type: 'boolean', required: true },
            ts: { type: 'timestamp', required: true },
            u: { type: 'uuid', required: true },
            j: { type: 'json', required: true },
            r: { type: 'ref', ref: 'things', required: true },
            maybe: { type: 'number', required: false },
          },
        },
      ],
    });
    type Thing = Row<typeof app, 'things'>;
    expectTypeOf<Thing['t']>().toEqualTypeOf<string>();
    expectTypeOf<Thing['n']>().toEqualTypeOf<number>();
    expectTypeOf<Thing['b']>().toEqualTypeOf<boolean>();
    expectTypeOf<Thing['ts']>().toEqualTypeOf<string>();
    expectTypeOf<Thing['u']>().toEqualTypeOf<string>();
    expectTypeOf<Thing['j']>().toEqualTypeOf<unknown>();
    expectTypeOf<Thing['r']>().toEqualTypeOf<string>();
    expectTypeOf<Thing['maybe']>().toEqualTypeOf<number | null | undefined>();
  });

  it('infers create and update inputs without implicit columns', () => {
    expectTypeOf<NewRow<App, 'tickets'>>().toEqualTypeOf<{
      shared?: boolean;
      title: string;
      status: string;
      assignee_id?: string | null;
      due_on?: string | null;
      project_id?: string | null;
    }>();
    expectTypeOf<RowPatch<App, 'comments'>>().toEqualTypeOf<{ ticket_id?: string; body?: string }>();
  });

  it('lists collection names', () => {
    expectTypeOf<CollectionName<App>>().toEqualTypeOf<'projects' | 'tickets' | 'comments'>();
  });
});

describe('client typing', () => {
  const client = createKelayClient({ dataApiUrl: 'http://data', app: ticketBoard, fetch: mockFetch(), ...auth });

  it('types collection methods from the app schema', () => {
    const tickets = client.collection('tickets');
    expectTypeOf(tickets.list).returns.resolves.toEqualTypeOf<Row<App, 'tickets'>[]>();
    expectTypeOf(tickets.get).returns.resolves.toEqualTypeOf<Row<App, 'tickets'> | null>();
    expectTypeOf(tickets.create).parameter(0).toEqualTypeOf<NewRow<App, 'tickets'>>();
    expectTypeOf(tickets.create).returns.resolves.toEqualTypeOf<Row<App, 'tickets'>>();
    expectTypeOf(tickets.remove).returns.resolves.toEqualTypeOf<boolean>();
  });

  it('rejects unknown collections, missing required fields and unknown where fields', () => {
    expectTypeOf(client.collection).parameter(0).toEqualTypeOf<'projects' | 'tickets' | 'comments'>();
    const tickets = client.collection('tickets');
    // @ts-expect-error title is required
    void (() => tickets.create({ status: 'todo' }));
    // @ts-expect-error no such field
    void (() => tickets.list({ where: { colour: 'red' } }));
    // @ts-expect-error status is text
    void (() => tickets.update('t1', { status: 3 }));
    void (() => tickets.list({ where: { due_on: { lt: '2026-12-01T00:00:00Z' }, status: { in: ['todo'] } }, orderBy: [{ field: 'created_at' }] }));
  });

  it('falls back to untyped rows for a slug-only app', () => {
    const wiki = createKelayClient({ dataApiUrl: 'http://data', app: 'wiki', fetch: mockFetch(), ...auth });
    expectTypeOf(wiki.collection('pages').list).returns.resolves.toEqualTypeOf<AnyRow[]>();
  });
});

describe('define helpers', () => {
  it('defineApp returns the schema unchanged and rejects invalid ones', () => {
    const schema = fx('ticket-board/schema.json');
    expect(defineApp(schema)).toBe(schema);
    expect(() => defineApp({ app: 'Bad Slug', roles: [], collections: [] })).toThrow(KelayError);
    expect(() => defineApp({ app: 'Bad Slug', roles: [], collections: [] })).toThrow(/invalid app schema/);
  });

  it('definePolicy and defineGraph validate and keep literal types', () => {
    const policy = definePolicy({ member: { tickets: { read: 'mine_shared', create: 'all', update: 'mine', delete: 'none' } } });
    expectTypeOf(policy.member.tickets.read).toEqualTypeOf<'mine_shared'>();
    expect(definePolicy(fx('ticket-board/policy.json')).guest.tickets.create).toBe('none');
    expect(() => definePolicy({ member: { tickets: { read: 'everyone' } } } as never)).toThrow(/invalid policy matrix/);

    const graph = defineGraph(fx('ticket-board/graph.overdue-summary.json'));
    expect(graph.start).toBe('collect');
    expect(() => defineGraph({ name: 'g', start: 'a', nodes: { a: { next: ['b'] } } } as never)).toThrow(KelayError);
  });
});
