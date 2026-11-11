import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { AppSchema, GraphSpec, PolicyMatrix, QueryRequest } from './index.ts';
import { loadAppRegistry } from './registry.ts';

const fx = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${p}`, import.meta.url)), 'utf8'));

describe('contracts fixtures', () => {
  it('ticket-board schema, policy and graph parse', () => {
    expect(AppSchema.parse(fx('ticket-board/schema.json')).collections).toHaveLength(3);
    expect(PolicyMatrix.parse(fx('ticket-board/policy.json')).member?.tickets?.read).toBe('mine_shared');
    expect(GraphSpec.parse(fx('ticket-board/graph.overdue-summary.json')).start).toBe('collect');
  });
  it('loads the local registry with schema and policy files resolved', () => {
    const reg = loadAppRegistry(fileURLToPath(new URL('../fixtures/apps.local.json', import.meta.url)));
    expect(reg.apps['ticket-board']?.schema.app).toBe('ticket-board');
    expect(reg.apps['ticket-board']?.policy?.guest?.tickets?.create).toBe('none');
  });
  it('rejects unsafe identifiers in queries', () => {
    expect(() => QueryRequest.parse({ op: 'select', collection: 'tickets; drop table x' })).toThrow();
    expect(QueryRequest.parse({ op: 'select', collection: 'tickets', where: { status: { in: ['todo'] } } }).op).toBe('select');
  });
});
