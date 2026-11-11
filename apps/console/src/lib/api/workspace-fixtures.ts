// Mock data for the Agent workspace tab, reproduced from design/prototype/index.html.
// The tab falls back to these when the shell passes no API data.
import { CONSENTS, MEMBERSHIPS, PEOPLE, TOOL_CALLS } from './fixtures';
import type { Consent, Member, ToolCall } from './types';

/** The moment relative fixture times ("2 min ago") are measured from. */
export const FIXTURE_NOW = new Date('2026-11-11T10:45:00+09:00').getTime();

export type TabMember = Pick<Member, 'userId' | 'name' | 'role' | 'color'>;

export const fixtureMembers = (app: string): TabMember[] =>
  MEMBERSHIPS.filter((m) => m.app === app).flatMap((m) => {
    const p = PEOPLE.find((x) => x.userId === m.userId);
    return p ? [{ userId: p.userId, name: p.name, role: m.role, color: p.color }] : [];
  });

export const fixtureConsents = (app: string): Consent[] =>
  CONSENTS.filter((c) => c.app === app).map(({ lastUsedAgo, ...c }) => ({ ...c, lastUsedAt: new Date(FIXTURE_NOW - lastUsedAgo).toISOString() }));

export const fixtureToolCalls = (app: string): ToolCall[] =>
  (TOOL_CALLS[app] ?? []).map(({ time, ...c }) => ({ ...c, at: new Date(`2026-11-11T${time}:00+09:00`).toISOString() }));
