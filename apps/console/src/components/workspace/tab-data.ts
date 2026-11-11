import 'server-only';
import { isApiError } from '@/lib/api/errors';
import { getMockState } from '@/lib/api/mock';
import type { AccessPreview, AppDetail, ConsoleApi, Member, MetricsRange, WorkspaceTab } from '@/lib/api/types';

/** The range the Monitoring tab opens on; the tab loads the others through an action. */
export const INITIAL_RANGE: MetricsRange = '14d';

/** Null for an app that has nothing deployed yet, so it has no schema or rules to show. */
async function policyOrNull(api: ConsoleApi, app: string) {
  try {
    return await api.getPolicy(app);
  } catch (e) {
    if (isApiError(e) && e.status === 404) return null;
    throw e;
  }
}

/** "Preview as" offers one member who is not an admin and one admin. */
const previewViewers = (members: Member[]): Member[] => {
  const active = members.filter((m) => m.status === 'active');
  return [active.find((m) => m.role !== 'admin'), active.find((m) => m.role === 'admin')].filter((m): m is Member => !!m);
};

/** Fills what the member list itself does not carry: the member's assistant and their roles in the builder's other apps. */
async function withConnections(api: ConsoleApi, app: AppDetail, members: Member[]): Promise<Member[]> {
  if (api.mode === 'mock') return members;
  const [consents, apps] = await Promise.all([api.listConsents(app.id), api.listApps()]);
  const others = await Promise.all(apps.filter((a) => a.id !== app.id).map(async (a) => ({ app: a, members: await api.listMembers(a.id) })));
  return members.map((m) => ({
    ...m,
    assistant: m.assistant ?? consents.find((c) => c.userId === m.userId)?.client.name ?? null,
    otherApps: others.flatMap((o) => {
      const there = o.members.find((x) => x.userId === m.userId);
      return there ? [{ app: o.app.id, name: o.app.name, role: there.role }] : [];
    }),
  }));
}

/**
 * Server-side data for the workspace tabs. Tabs fall back to bundled fixtures when a prop is
 * undefined, so every prop is passed explicitly (empty rather than absent) to keep Control API
 * mode from showing mock data.
 */
export async function loadTabData(api: ConsoleApi, app: AppDetail, tab: WorkspaceTab): Promise<Record<string, unknown>> {
  switch (tab) {
    case 'access': {
      const [members, policy] = await Promise.all([api.listMembers(app.id), policyOrNull(api, app.id)]);
      const viewers = policy ? previewViewers(members) : [];
      const previews = await Promise.all(viewers.map((m) => api.previewAccess(app.id, m.userId)));
      return { policy, viewers, previews: previews.filter((p): p is AccessPreview => p !== null) };
    }
    case 'agent': {
      const [members, consents, toolCalls] = await Promise.all([api.listMembers(app.id), api.listConsents(app.id), api.listToolCalls(app.id)]);
      return { members, consents, toolCalls, now: Date.now() };
    }
    case 'qa':
      return { qa: await api.getQa(app.id) };
    case 'feedback': {
      const [tickets, reports, members, me] = await Promise.all([api.listTickets(app.id), api.listReports(app.id), api.listMembers(app.id), api.getMe()]);
      return { tickets, reports, people: members.map((m) => ({ userId: m.userId, name: m.name, color: m.color })), team: me.team };
    }
    case 'users': {
      const [members, policy, me] = await Promise.all([api.listMembers(app.id), policyOrNull(api, app.id), api.getMe()]);
      return {
        members: await withConnections(api, app, members),
        roles: policy?.schema.roles ?? [...new Set(members.map((m) => m.role))],
        team: me.team,
        // Mock sign-in times are fixed offsets from the mock's own clock.
        now: api.mode === 'mock' ? getMockState().now : Date.now(),
      };
    }
    case 'monitoring': {
      const [metrics, grants, apps, members] = await Promise.all([api.getMetrics(app.id, INITIAL_RANGE), api.listGrants(), api.listApps(), api.listMembers(app.id)]);
      return {
        initialMetrics: metrics,
        grants: grants.filter((g) => g.from === app.id || g.to === app.id),
        appNames: Object.fromEntries(apps.map((a) => [a.id, a.name])),
        memberNames: Object.fromEntries(members.map((m) => [m.userId, m.name])),
      };
    }
    default:
      return {};
  }
}
