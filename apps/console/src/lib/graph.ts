import { AGENTS_NODE, IDENTITY_NODE, type AppSummary, type Consent, type Grant } from '@/lib/api/types';

export interface Pos {
  x: number;
  y: number;
}

/** Positions (percent of the canvas) from the prototype for its fixture apps. */
const PROTOTYPE_POS: Record<string, Pos> = {
  [IDENTITY_NODE]: { x: 54, y: 45 },
  [AGENTS_NODE]: { x: 11, y: 52 },
  'ticket-board': { x: 22, y: 17 },
  'team-wiki': { x: 75, y: 17 },
  docs: { x: 50, y: 87 },
  'lead-qualifier': { x: 86, y: 74 },
};

/** Fixture apps keep their prototype spots; any other app goes on an ellipse around Kelay ID. */
export function layoutGraph(apps: readonly AppSummary[]): Record<string, Pos> {
  const pos: Record<string, Pos> = { [IDENTITY_NODE]: PROTOTYPE_POS[IDENTITY_NODE]!, [AGENTS_NODE]: PROTOTYPE_POS[AGENTS_NODE]! };
  const rest = apps.filter((a) => !PROTOTYPE_POS[a.id]);
  for (const a of apps) {
    const known = PROTOTYPE_POS[a.id];
    if (known) pos[a.id] = known;
  }
  rest.forEach((a, i) => {
    const angle = -Math.PI / 2 + ((i + 0.5) / rest.length) * 2 * Math.PI;
    pos[a.id] = { x: 56 + 32 * Math.cos(angle), y: 48 + 36 * Math.sin(angle) };
  });
  return pos;
}

export function nodeName(apps: readonly AppSummary[], id: string): string {
  if (id === AGENTS_NODE) return 'Personal agents';
  if (id === IDENTITY_NODE) return 'Kelay ID';
  return apps.find((a) => a.id === id)?.name ?? id;
}

export const mcpEndpointFor = (a: Pick<AppSummary, 'handle' | 'id'>): string => `https://kelay.app/${a.handle}/${a.id}/mcp`;

/**
 * Personal-agent edges. When the Control API does not model them as grants, derive one edge per
 * app from members' MCP consents.
 */
export function withAgentLinks(grants: readonly Grant[], consents: readonly Consent[], apps: readonly AppSummary[]): Grant[] {
  if (grants.some((g) => g.from === AGENTS_NODE)) return [...grants];
  const byApp = new Map<string, Consent[]>();
  for (const c of consents) byApp.set(c.app, [...(byApp.get(c.app) ?? []), c]);
  const derived: Grant[] = [...byApp.entries()]
    .filter(([app]) => apps.some((a) => a.id === app))
    .map(([app, cs]) => ({
      id: `agents-${app}`,
      from: AGENTS_NODE,
      to: app,
      kind: 'MCP',
      what: `Members use ${nodeName(apps, app)} from their own AI assistant`,
      status: 'connected',
      callsPerDay: 0,
      since: cs.map((c) => c.grantedAt).sort()[0] ?? new Date(0).toISOString(),
      proposalId: null,
    }));
  return [...grants, ...derived];
}

export type Selection = { type: 'node' | 'link'; id: string } | null;

export interface Related {
  nodes: Set<string>;
  links: Set<string>;
  ident: Set<string>;
}

/** What stays highlighted for a selection; everything else is dimmed. */
export function related(sel: Selection, apps: readonly AppSummary[], links: readonly Grant[]): Related | null {
  if (!sel) return null;
  if (sel.type === 'link') {
    const l = links.find((x) => x.id === sel.id);
    return l ? { nodes: new Set([l.from, l.to]), links: new Set([l.id]), ident: new Set() } : null;
  }
  const k = sel.id;
  if (k === IDENTITY_NODE) {
    return { nodes: new Set([IDENTITY_NODE, ...apps.map((a) => a.id)]), links: new Set(), ident: new Set(apps.map((a) => a.id)) };
  }
  const ls = links.filter((l) => l.from === k || l.to === k);
  const nodes = new Set([k, ...ls.flatMap((l) => [l.from, l.to])]);
  if (k !== AGENTS_NODE) nodes.add(IDENTITY_NODE);
  return { nodes, links: new Set(ls.map((l) => l.id)), ident: new Set(k !== AGENTS_NODE ? [k] : []) };
}
