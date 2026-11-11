import 'server-only';
import { decideProposalAction } from '@/app/actions';
import type { AppDetail, ConsoleApi, WorkspaceTab } from '@/lib/api/types';

/**
 * Server-side data for the tabs that accept it as props. Tabs fall back to bundled fixtures when a
 * prop is undefined, so every prop is passed explicitly (empty rather than absent) to keep
 * Control API mode from showing mock data.
 */
export async function loadTabData(api: ConsoleApi, app: AppDetail, tab: WorkspaceTab): Promise<Record<string, unknown>> {
  switch (tab) {
    case 'access': {
      const [members, policy] = await Promise.all([api.listMembers(app.id), api.getPolicy(app.id).catch(() => null)]);
      const collections = policy?.schema.collections.map((c) => c.name) ?? [];
      const samples = (await Promise.all(collections.map((c) => api.getAccessSamples(app.id, c)))).find((s) => s !== null) ?? [];
      return { members, samples };
    }
    case 'agent': {
      const [members, consents, toolCalls] = await Promise.all([api.listMembers(app.id), api.listConsents(app.id), api.listToolCalls(app.id)]);
      return { members, consents, toolCalls, now: Date.now() };
    }
    case 'qa':
      return { qa: await api.getQa(app.id) };
    case 'feedback': {
      const [tickets, reports, members, me] = await Promise.all([api.listTickets(app.id), api.listReports(app.id), api.listMembers(app.id), api.getMe()]);
      return {
        tickets,
        reports,
        people: members.map((m) => ({ userId: m.userId, name: m.name, color: m.color })),
        team: me.team,
        onProposalChange: decideProposalAction,
      };
    }
    default:
      return {};
  }
}
