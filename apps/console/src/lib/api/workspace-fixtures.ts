// Mock data for the Access and Agent workspace tabs, reproduced from design/prototype/index.html.
// The tabs fall back to these when the shell passes no API data.
import { BOARD, CONSENTS, MEMBERSHIPS, PEOPLE, TOOL_CALLS, boardSamples } from './fixtures';
import type { AccessSample, Consent, Member, ToolCall } from './types';

export interface AccessRule {
  id: string;
  collection: string;
  who: string;
  verb: string;
  what: string;
  sql: string;
  /** Feedback ticket the rule came from; shown as "New · from FB-131". */
  from?: string;
  /** Shown above the rules while this rule is switched off. */
  offWarning?: { title: string; detail: string };
  /** How the rule narrows "Preview as": `own` limits non-admins to their rows, `admin_all` lets admins see every row. */
  preview?: 'own' | 'admin_all';
}

export const ACCESS_RULES: Record<string, AccessRule[]> = {
  'ticket-board': [
    {
      id: 'r1', collection: 'tickets', who: 'Members', verb: 'view', what: 'tickets they created or are assigned to', from: 'FB-131', preview: 'own',
      offWarning: { title: 'Everyone sees every ticket.', detail: '6 people asked to see only their own (FB-131).' },
      sql: 'create policy "members_view_own_tickets"\non tickets for select\nusing (\n  auth.uid() = created_by\n  or auth.uid() = assignee_id\n);',
    },
    {
      id: 'r2', collection: 'tickets', who: 'Admins', verb: 'view', what: 'all tickets', preview: 'admin_all',
      sql: 'create policy "admins_view_all_tickets"\non tickets for select\nusing (team_role(auth.uid()) = \'admin\');',
    },
    {
      id: 'r3', collection: 'tickets', who: 'The assignee or Admins', verb: 'move', what: 'a ticket between columns',
      sql: 'create policy "assignee_moves_ticket"\non tickets for update\nusing (\n  auth.uid() = assignee_id\n  or team_role(auth.uid()) = \'admin\'\n);',
    },
    {
      id: 'r4', collection: 'tickets', who: 'Admins', verb: 'delete', what: 'tickets',
      sql: 'create policy "admins_delete_tickets"\non tickets for delete\nusing (team_role(auth.uid()) = \'admin\');',
    },
    {
      id: 'c1', collection: 'comments', who: 'Everyone on the team', verb: 'view', what: 'all comments',
      sql: 'create policy "team_views_comments"\non comments for select\nusing (true);',
    },
    {
      id: 'c2', collection: 'comments', who: 'Members', verb: 'edit', what: 'comments they wrote',
      sql: 'create policy "members_edit_own_comments"\non comments for update\nusing (auth.uid() = created_by);',
    },
    {
      id: 'p1', collection: 'projects', who: 'Everyone on the team', verb: 'view', what: 'all projects',
      sql: 'create policy "team_views_projects"\non projects for select\nusing (true);',
    },
    {
      id: 'p2', collection: 'projects', who: 'Admins', verb: 'create', what: 'projects',
      sql: 'create policy "admins_create_projects"\non projects for insert\nwith check (team_role(auth.uid()) = \'admin\');',
    },
  ],
};

export const ACCESS_COLLECTIONS: Record<string, string[]> = {
  'ticket-board': ['tickets', 'comments', 'projects'],
};

/** The moment relative fixture times ("2 min ago") are measured from. */
export const FIXTURE_NOW = new Date('2026-11-11T10:45:00+09:00').getTime();

export type TabMember = Pick<Member, 'userId' | 'name' | 'role' | 'color'>;

export const fixtureMembers = (app: string): TabMember[] =>
  MEMBERSHIPS.filter((m) => m.app === app).flatMap((m) => {
    const p = PEOPLE.find((x) => x.userId === m.userId);
    return p ? [{ userId: p.userId, name: p.name, role: m.role, color: p.color }] : [];
  });

export const fixtureSamples = (app: string): AccessSample[] => (app === 'ticket-board' ? boardSamples(BOARD) : []);

export const fixtureConsents = (app: string): Consent[] =>
  CONSENTS.filter((c) => c.app === app).map(({ lastUsedAgo, ...c }) => ({ ...c, lastUsedAt: new Date(FIXTURE_NOW - lastUsedAgo).toISOString() }));

export const fixtureToolCalls = (app: string): ToolCall[] =>
  (TOOL_CALLS[app] ?? []).map(({ time, ...c }) => ({ ...c, at: new Date(`2026-11-11T${time}:00+09:00`).toISOString() }));
