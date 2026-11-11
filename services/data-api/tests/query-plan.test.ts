import { describe, expect, it } from 'vitest';
import { CollectionDef, QueryRequest } from '@kelay/contracts';
import { ApiError } from '../src/errors.ts';
import { DEFAULT_SELECT_LIMIT, planQuery } from '../src/query.ts';

const notes = CollectionDef.parse({
  name: 'notes',
  shared: true,
  fields: {
    body: { type: 'text', required: true },
    score: { type: 'number' },
    done: { type: 'boolean' },
    meta: { type: 'json' },
    parent_id: { type: 'ref', ref: 'notes' },
    // A field that reuses a reserved name must not make that column writable.
    id: { type: 'text' },
  },
});

const plan = (req: unknown) => planQuery(notes, QueryRequest.parse(req));
const rejects = (req: unknown) => expect(() => plan(req)).toThrow(ApiError);

describe('planQuery', () => {
  it('compiles a select with quoted identifiers and bound values', () => {
    const { query, probe } = plan({
      op: 'select',
      collection: 'notes',
      where: { body: { like: 'a%' }, score: { gte: 1, lt: 5 }, done: false },
      orderBy: [{ field: 'score', dir: 'desc' }],
      limit: 10,
    });
    expect(query.sql).toBe(
      'select * from "app"."notes" where ("body" like $1 and "score" >= $2 and "score" < $3 and "done" = $4) order by "score" desc limit $5',
    );
    expect(query.parameters).toEqual(['a%', 1, 5, false, 10]);
    expect(probe).toBeUndefined();
  });

  it('caps a select without a limit', () => {
    expect(plan({ op: 'select', collection: 'notes' }).query.parameters).toEqual([DEFAULT_SELECT_LIMIT]);
  });

  it('sends JSON values as JSON text, including arrays', () => {
    const { query } = plan({ op: 'insert', collection: 'notes', values: { body: 'x', meta: [1, { a: 'b' }] } });
    expect(query.sql).toBe('insert into "app"."notes" ("body", "meta") values ($1, $2) returning *');
    expect(query.parameters).toEqual(['x', '[1,{"a":"b"}]']);
    expect(plan({ op: 'select', collection: 'notes', where: { meta: 'x' } }).query.parameters[0]).toBe('"x"');
  });

  it('inserts DEFAULT for every row when no row names a column', () => {
    const { query } = plan({ op: 'insert', collection: 'notes', values: [{}, {}] });
    expect(query.sql).toBe('insert into "app"."notes" ("id") values (default), (default) returning *');
  });

  it('bumps updated_at and builds a probe with the same where', () => {
    const { query, probe } = plan({ op: 'update', collection: 'notes', where: { shared: true }, values: { done: true } });
    expect(query.sql).toBe('update "app"."notes" set "done" = $1, "updated_at" = now() where "shared" = $2 returning *');
    expect(probe?.sql).toBe('select 1 as "one" from "app"."notes" where "shared" = $1 limit $2');
    expect(probe?.parameters).toEqual([true, 1]);
  });

  it('compiles deletes with a probe', () => {
    const { query, probe } = plan({ op: 'delete', collection: 'notes', where: { parent_id: { in: [] } } });
    expect(query.sql).toBe('delete from "app"."notes" where false returning *');
    expect(probe?.sql).toBe('select 1 as "one" from "app"."notes" where false limit $1');
  });

  it('keeps reserved columns read-only even when a field reuses the name', () => {
    rejects({ op: 'insert', collection: 'notes', values: { body: 'x', id: 'n1' } });
    expect(plan({ op: 'select', collection: 'notes', where: { id: { ne: null } } }).query.sql).toContain('"id" is not null');
  });

  it.each([
    ['in on JSON', { meta: { in: ['x'] } }],
    ['gt on boolean', { done: { gt: true } }],
    ['like on a number', { score: { like: '1%' } }],
    ['a string for a number', { score: '1' }],
    ['a prototype key', { constructor: 'x' }],
  ])('rejects %s', (_name, where) => {
    rejects({ op: 'select', collection: 'notes', where });
  });

  it('rejects non-finite numbers', () => {
    rejects({ op: 'insert', collection: 'notes', values: { body: 'x', score: Number.POSITIVE_INFINITY } });
  });
});
