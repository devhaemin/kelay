import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PolicyError, orderCollections, validateAppSchema, validatePolicy } from './index.ts';

const fx = (p: string) =>
  JSON.parse(readFileSync(createRequire(import.meta.url).resolve(`@kelay/contracts/fixtures/${p}`), 'utf8'));
const schema = fx('ticket-board/schema.json');
const policy = fx('ticket-board/policy.json');

const problemsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PolicyError);
    return (e as PolicyError).problems;
  }
  throw new Error('expected a PolicyError');
};

describe('validateAppSchema', () => {
  it('accepts the ticket-board fixture', () => {
    expect(validateAppSchema(schema).collections.map((c) => c.name)).toEqual(['projects', 'tickets', 'comments']);
  });

  it('reports Zod shape errors with their path', () => {
    const problems = problemsOf(() => validateAppSchema({ ...schema, collections: [{ name: 'Bad Name', fields: {} }] }));
    expect(problems.some((p) => p.path === 'schema.collections.0.name')).toBe(true);
  });

  it('lists every semantic problem at once', () => {
    const problems = problemsOf(() =>
      validateAppSchema({
        app: 'broken',
        roles: ['admin', 'admin'],
        collections: [
          { name: 'notes', fields: { owner_id: { type: 'text' }, author: { type: 'number' } }, ownerField: 'author' },
          { name: 'links', fields: { note_id: { type: 'ref', ref: 'missing' }, raw: { type: 'uuid', ref: 'notes' } } },
          { name: 'pages', fields: { parent: { type: 'ref' } }, ownerField: 'nope' },
          { name: 'notes', fields: {} },
        ],
      }),
    );
    expect(problems.map((p) => p.path)).toEqual([
      'schema.roles',
      'schema.collections',
      'schema.collections.notes.fields.owner_id',
      'schema.collections.notes.ownerField',
      'schema.collections.links.fields.note_id',
      'schema.collections.links.fields.raw',
      'schema.collections.pages.fields.parent',
      'schema.collections.pages.ownerField',
    ]);
    expect(problems[2]?.message).toMatch(/implicit column/);
  });

  it('rejects ref cycles but allows self references', () => {
    const cyc = {
      app: 'cyc',
      roles: ['admin'],
      collections: [
        { name: 'a', fields: { b_id: { type: 'ref', ref: 'b' } } },
        { name: 'b', fields: { a_id: { type: 'ref', ref: 'a' } } },
      ],
    };
    expect(problemsOf(() => validateAppSchema(cyc))[0]?.message).toMatch(/cycle.*a, b/);
    const tree = { app: 'tree', roles: ['admin'], collections: [{ name: 'nodes', fields: { parent: { type: 'ref', ref: 'nodes' } } }] };
    expect(validateAppSchema(tree).collections).toHaveLength(1);
  });

  it('checks refs in action inputs', () => {
    const withAction = { ...schema, actions: [{ name: 'close', description: 'Close', input: { t: { type: 'ref', ref: 'nope' } } }] };
    expect(problemsOf(() => validateAppSchema(withAction))[0]?.path).toBe('schema.actions.close.input.t');
  });
});

describe('orderCollections', () => {
  it('puts ref targets first and otherwise keeps declaration order', () => {
    const { order, cycle } = orderCollections([
      { name: 'comments', fields: { ticket_id: { type: 'ref', ref: 'tickets' } } },
      { name: 'labels', fields: {} },
      { name: 'tickets', fields: { project_id: { type: 'ref', ref: 'projects' } } },
      { name: 'projects', fields: {} },
    ]);
    expect(order.map((c) => c.name)).toEqual(['labels', 'projects', 'tickets', 'comments']);
    expect(cycle).toEqual([]);
  });
});

describe('validatePolicy', () => {
  it('accepts the ticket-board fixture', () => {
    expect(validatePolicy(schema, policy).member?.tickets?.read).toBe('mine_shared');
  });

  it('reports unknown roles and collections, and too-long policy names', () => {
    const long = 'x'.repeat(60);
    const longSchema = { ...schema, roles: [...schema.roles, long] };
    const problems = problemsOf(() =>
      validatePolicy(longSchema, {
        owner: { tickets: { read: 'all', create: 'none', update: 'none', delete: 'none' } },
        member: { wiki: { read: 'all', create: 'none', update: 'none', delete: 'none' } },
        [long]: { tickets: { read: 'all', create: 'none', update: 'none', delete: 'none' } },
      }),
    );
    expect(problems.map((p) => p.path)).toEqual(['policy.owner', 'policy.member.wiki', `policy.${long}.tickets.read`]);
  });

  it('reports a malformed matrix', () => {
    const problems = problemsOf(() => validatePolicy(schema, { member: { tickets: { read: 'everyone' } } }));
    expect(problems.map((p) => p.path)).toContain('policy.member.tickets.read');
  });

  it('throws the schema problems first when the schema is invalid', () => {
    expect(problemsOf(() => validatePolicy({ app: 'x' }, policy))[0]?.path).toMatch(/^schema\./);
  });
});
