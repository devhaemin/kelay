// The prototype's seven-scene product story. Demo material: shown only in Story mode.
export interface Scene {
  key: string;
  title: string;
  href: string;
  need: string;
  answer: string;
}

export const SCENES: Scene[] = [
  { key: 'build', title: 'Build', href: '/app/new/screen', need: 'Building should be as easy as describing it.', answer: 'One paragraph becomes a Jira-style ticket board — screens and data — in under a minute.' },
  { key: 'access', title: 'Access rules', href: '/app/ticket-board/access', need: 'No access rules. Members want to see only their own tickets.', answer: 'Plain-language access rules (RLS) per collection, with “Preview as” any member.' },
  { key: 'ship', title: 'Ship', href: '/app/ticket-board/screen/ship', need: 'Shipping is hard. The builder wants to share it right away.', answer: 'Deploy runs the checks and hands back a link in one step.' },
  { key: 'qa', title: 'QA', href: '/app/ticket-board/qa', need: 'After sharing, moving a ticket threw a simple error.', answer: 'Typed actions, safe fallbacks and pre-deploy checks keep screens from breaking.' },
  { key: 'agent', title: 'Own agent', href: '/app/ticket-board/agent', need: 'Members want to use Ticket Board from their own AI assistant.', answer: 'They add it over MCP. Every call runs with their Kelay ID and the same access rules.' },
  { key: 'feedback', title: 'Feedback loop', href: '/app/ticket-board/feedback', need: 'Feedback should turn into improvements right away.', answer: '/feedback → tickets → a daily report from the Self-Improvement Agent → you approve.' },
  { key: 'graph', title: 'App graph', href: '/graph', need: 'Ticket Board, a wiki and docs should work together.', answer: 'MCP and A2A connect the apps, one Kelay ID opens all of them — small software compounds.' },
];

export const QUICK_LINKS = [
  { key: 'home', href: '/', label: 'Home' },
  { key: 'apps', href: '/apps', label: 'My Apps' },
  { key: 'screen', href: '/app/ticket-board/screen', label: 'Screen' },
  { key: 'users', href: '/app/ticket-board/users', label: 'Users' },
  { key: 'monitoring', href: '/app/ticket-board/monitoring', label: 'Monitoring' },
] as const;

export interface RouteInfo {
  name: 'home' | 'apps' | 'graph' | 'app' | 'other';
  app?: string;
  tab?: string;
  ship?: boolean;
}

export function parseRoute(pathname: string): RouteInfo {
  const [a, b, c, d] = pathname.replace(/^\/+/, '').split('/');
  if (!a) return { name: 'home' };
  if (a === 'apps') return { name: 'apps' };
  if (a === 'graph') return { name: 'graph' };
  if (a === 'app' && b) return { name: 'app', app: b, tab: c || 'screen', ship: d === 'ship' };
  return { name: 'other' };
}

/** Scene shown for a route, or -1. Mirrors the prototype's `sceneIndex`. */
export function sceneIndex(r: RouteInfo): number {
  if (r.name === 'graph') return 6;
  if (r.name !== 'app') return -1;
  if (r.app === 'new') return 0;
  if (r.ship) return 2;
  return ({ access: 1, qa: 3, agent: 4, feedback: 5 } as Record<string, number>)[r.tab ?? ''] ?? -1;
}

export const STORY_COOKIE = 'kelay_story';
