import { AppSchema, PolicyMatrix } from '@kelay/contracts';
import schemaJson from '@kelay/contracts/fixtures/ticket-board/schema.json';
import policyJson from '@kelay/contracts/fixtures/ticket-board/policy.json';
import { describe, expect, it } from 'vitest';
import { BOARD, boardSamples } from './api/fixtures';
import { countPolicies, policySql, roleLabel, rulesFor, scopePhrase, verbs, visibleSamples, withScope } from './policy';

const schema = AppSchema.parse(schemaJson);
const matrix = PolicyMatrix.parse(policyJson);
const tickets = schema.collections.find((c) => c.name === 'tickets')!;
const projects = schema.collections.find((c) => c.name === 'projects')!;

describe('policy view', () => {
  it('groups a role’s ops that share a scope into one rule', () => {
    const rows = rulesFor(schema, matrix, 'tickets');
    expect(rows.map((r) => [r.role, r.scope, r.ops.join(',')])).toEqual([
      ['admin', 'all', 'read,create,update,delete'],
      ['member', 'all', 'create'],
      ['member', 'mine_shared', 'read'],
      ['member', 'mine', 'update'],
      ['guest', 'mine_shared', 'read'],
    ]);
  });

  it('reads scopes as plain language using the owner field', () => {
    expect(`${roleLabel('member')} can ${verbs(['read'])} ${scopePhrase(tickets, 'mine_shared', ['read'])}`).toBe(
      'Members can view tickets assigned to them or shared with the team',
    );
    expect(scopePhrase(tickets, 'mine', ['update'])).toBe('tickets assigned to them');
    expect(scopePhrase(projects, 'mine_shared', ['read'])).toBe('projects they created');
    expect(verbs(['read', 'create', 'update', 'delete'])).toBe('view, create, edit and delete');
  });

  it('renders the policy SQL from contracts §3', () => {
    expect(policySql(tickets, 'member', 'read', 'mine_shared')).toBe(
      `create policy "tickets_read_member"\non app.tickets for select\nusing (\n  org_id = kelay.org()\n  and kelay.role() = 'member'\n  and (assignee_id = kelay.uid() or shared)\n);`,
    );
    const update = policySql(tickets, 'member', 'update', 'mine_shared');
    expect(update).toContain('using (\n  org_id = kelay.org()\n  and kelay.role() = \'member\'\n  and (assignee_id = kelay.uid() or shared)\n)');
    expect(update).toContain('with check (\n  org_id = kelay.org()\n  and kelay.role() = \'member\'\n  and assignee_id = kelay.uid()\n);');
    expect(policySql(tickets, 'member', 'create', 'all')).toContain('for insert\nwith check (');
    expect(policySql(tickets, 'guest', 'delete', 'none')).toMatch(/^-- tickets_delete_guest: no policy/);
  });

  it('previews what a member sees under RLS', () => {
    const samples = boardSamples(BOARD);
    expect(visibleSamples(tickets, matrix, 'member', 'u1', samples).map((s) => s.id)).toEqual(['TCK-41', 'TCK-38', 'TCK-36', 'TCK-30']);
    expect(visibleSamples(tickets, matrix, 'admin', 'u3', samples)).toHaveLength(BOARD.length);
    const closed = withScope(matrix, 'member', 'tickets', ['read'], 'none');
    expect(visibleSamples(tickets, closed, 'member', 'u1', samples)).toEqual([]);
    expect(countPolicies(closed)).toBe(countPolicies(matrix) - 1);
  });
});
