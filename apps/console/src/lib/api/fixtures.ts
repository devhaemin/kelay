// Mock data reproduced from design/prototype/index.html. Relative times ("2h ago") are offsets
// from the moment the mock state is created, so they stay true while the dev server runs.
import { AppSchema, PolicyMatrix } from '@kelay/contracts';
import ticketBoardSchema from '@kelay/contracts/fixtures/ticket-board/schema.json';
import ticketBoardPolicy from '@kelay/contracts/fixtures/ticket-board/policy.json';
import type {
  AccessSample,
  AppDetail,
  AppMetrics,
  AppPolicy,
  BoardCard,
  Builder,
  ChatMessage,
  Consent,
  FeedbackTicket,
  Grant,
  GraphOverview,
  ImprovementReport,
  Member,
  MetricsRange,
  Provider,
  QaSummary,
  ToolCall,
  WorkspaceTab,
} from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Absolute dates in the prototype are in Korea time. */
const kst = (date: string, time = '10:00'): string => new Date(`${date}T${time}:00+09:00`).toISOString();

export const HANDLE = 'jeongyun';
export const BASE_URL = 'https://kelay.app';

export const ME: Builder = { name: 'Jeongyun Lee', handle: HANDLE, email: 'jeongyun@biviostudio.com', team: 'Orum Studio' };

export interface Person {
  userId: string;
  name: string;
  email: string;
  provider: Provider;
  createdAt: string;
  /** Milliseconds before "now"; null when the person never signed in. */
  lastSignInAgo: number | null;
  color: string;
}

export const PEOPLE: Person[] = [
  { userId: 'u1', name: 'Mina Kim', email: 'mina@orum.studio', provider: 'google', createdAt: kst('2026-10-02'), lastSignInAgo: 2 * MIN, color: '#4f6bff' },
  { userId: 'u2', name: 'Daniel Park', email: 'daniel@orum.studio', provider: 'google', createdAt: kst('2026-10-02'), lastSignInAgo: HOUR, color: '#1f9d55' },
  { userId: 'u3', name: 'Jiwoo Choi', email: 'jiwoo@orum.studio', provider: 'email', createdAt: kst('2026-10-01'), lastSignInAgo: DAY + 2 * HOUR, color: '#b7791f' },
  { userId: 'u4', name: 'Seoyeon Lee', email: 'seoyeon@orum.studio', provider: 'kakao', createdAt: kst('2026-10-05'), lastSignInAgo: 3 * DAY, color: '#8b5cf6' },
  { userId: 'u5', name: 'Hyunwoo Jang', email: 'hyunwoo@orum.studio', provider: 'google', createdAt: kst('2026-11-09'), lastSignInAgo: null, color: '#d64545' },
  { userId: 'u6', name: 'Sora Han', email: 'sora@orum.studio', provider: 'github', createdAt: kst('2026-10-12'), lastSignInAgo: 7 * DAY, color: '#0ea5e9' },
];

export interface Membership {
  app: string;
  userId: string;
  role: string;
  plan: string;
  status: Member['status'];
}

const membershipsFor = (app: string, roleOf: (userId: string) => string): Membership[] =>
  PEOPLE.map((p) => ({ app, userId: p.userId, role: roleOf(p.userId), plan: 'team', status: p.userId === 'u5' ? 'unconfirmed' : 'active' }));

export const MEMBERSHIPS: Membership[] = [
  ...membershipsFor('ticket-board', (u) => (u === 'u3' ? 'admin' : 'member')),
  ...membershipsFor('team-wiki', (u) => (u === 'u3' ? 'admin' : 'editor')),
  ...membershipsFor('docs', (u) => (u === 'u3' ? 'admin' : 'member')),
];

const schemaFor = (app: string, roles: string[], collections: AppSchema['collections']): AppSchema =>
  AppSchema.parse({ app, roles, collections });

const allOps = { read: 'all', create: 'all', update: 'all', delete: 'all' } as const;

export interface MockApp extends AppDetail {
  /** Fixture the dev preview stands in with; real apps have a preview URL instead. */
  template: string | null;
  policy: AppPolicy;
  /** Milliseconds before "now". */
  updatedAgo: number;
}

const appUrls = (id: string) => ({
  productionUrl: `${BASE_URL}/${HANDLE}/${id}`,
  mcpEndpoint: `${BASE_URL}/${HANDLE}/${id}/mcp`,
});

export const APPS: MockApp[] = [
  {
    id: 'ticket-board', handle: HANDLE, name: 'Ticket Board', emoji: '🎫', color: '#e3ecff',
    description: 'Jira-style board for the team’s tasks. Built from one paragraph.',
    status: 'live', users: 12, runs: 1900, newFeedback: 3, updatedAt: '', updatedAgo: 2 * HOUR,
    ...appUrls('ticket-board'), previewUrl: null, version: 'v12',
    pendingChange: { title: 'Members see only their own tickets', count: 1 },
    template: 'ticket-board',
    policy: {
      schema: AppSchema.parse(ticketBoardSchema),
      matrix: PolicyMatrix.parse(ticketBoardPolicy),
      notes: [{ role: 'member', collection: 'tickets', op: 'read', from: 'FB-131' }],
    },
  },
  {
    id: 'team-wiki', handle: HANDLE, name: 'Team Wiki', emoji: '📚', color: '#e6f6ec',
    description: 'Notion-style pages for specs, decisions and weekly notes.',
    status: 'live', users: 10, runs: 820, newFeedback: 1, updatedAt: '', updatedAgo: DAY + 3 * HOUR,
    ...appUrls('team-wiki'), previewUrl: null, version: 'v7', pendingChange: null, template: null,
    policy: {
      schema: schemaFor('team-wiki', ['admin', 'editor', 'viewer'], [
        { name: 'pages', label: 'Pages', shared: true, fields: { title: { type: 'text', required: true }, body: { type: 'json' } } },
        { name: 'notes', label: 'Weekly notes', fields: { week: { type: 'text', required: true }, body: { type: 'json' } } },
      ]),
      matrix: {
        admin: { pages: allOps, notes: allOps },
        editor: { pages: { read: 'all', create: 'all', update: 'mine_shared', delete: 'mine' }, notes: { read: 'all', create: 'all', update: 'all', delete: 'none' } },
        viewer: { pages: { read: 'all', create: 'none', update: 'none', delete: 'none' }, notes: { read: 'all', create: 'none', update: 'none', delete: 'none' } },
      },
      notes: [],
    },
  },
  {
    id: 'docs', handle: HANDLE, name: 'Docs', emoji: '📄', color: '#fdf3e1',
    description: 'Office documents — write, review and share files with the team.',
    status: 'live', users: 12, runs: 640, newFeedback: 0, updatedAt: '', updatedAgo: 3 * DAY,
    ...appUrls('docs'), previewUrl: null, version: 'v4', pendingChange: null, template: null,
    policy: {
      schema: schemaFor('docs', ['admin', 'member'], [
        { name: 'documents', label: 'Documents', shared: true, fields: { title: { type: 'text', required: true }, file_key: { type: 'text' } } },
        { name: 'reviews', label: 'Reviews', fields: { document_id: { type: 'ref', ref: 'documents', required: true }, body: { type: 'text' } } },
      ]),
      matrix: {
        admin: { documents: allOps, reviews: allOps },
        member: { documents: { read: 'mine_shared', create: 'all', update: 'mine', delete: 'mine' }, reviews: { read: 'all', create: 'all', update: 'mine', delete: 'mine' } },
      },
      notes: [],
    },
  },
  {
    id: 'lead-qualifier', handle: HANDLE, name: 'Lead Qualifier', emoji: '🎯', color: '#f1eafe',
    description: 'Scores inbound leads and books meetings with qualified ones.',
    status: 'draft', users: 0, runs: null, newFeedback: 0, updatedAt: '', updatedAgo: 5 * DAY,
    ...appUrls('lead-qualifier'), previewUrl: null, version: null, pendingChange: null, template: null,
    policy: {
      schema: schemaFor('lead-qualifier', ['admin', 'sales'], [
        { name: 'leads', label: 'Leads', fields: { company: { type: 'text', required: true }, score: { type: 'number' } } },
        { name: 'meetings', label: 'Meetings', fields: { lead_id: { type: 'ref', ref: 'leads', required: true }, starts_at: { type: 'timestamp' } } },
      ]),
      matrix: {
        admin: { leads: allOps, meetings: allOps },
        sales: { leads: { read: 'mine', create: 'all', update: 'mine', delete: 'none' }, meetings: { read: 'mine', create: 'all', update: 'mine', delete: 'mine' } },
      },
      notes: [],
    },
  },
];

/** Templates the mock "builds" from a prompt. */
export const TEMPLATES: { match: RegExp; from: string | null; name: string; emoji: string; color: string; description: string }[] = [
  { match: /ticket|jira|kanban/i, from: 'ticket-board', name: 'Ticket Board', emoji: '🎫', color: '#e3ecff', description: 'Jira-style board for the team’s tasks. Built from one paragraph.' },
  { match: /wiki|notion/i, from: 'team-wiki', name: 'Team Wiki', emoji: '📚', color: '#e6f6ec', description: 'Notion-style pages for specs, decisions and weekly notes.' },
  { match: /doc/i, from: 'docs', name: 'Docs', emoji: '📄', color: '#fdf3e1', description: 'Office documents — write, review and share files with the team.' },
  { match: /lead/i, from: 'lead-qualifier', name: 'Lead Qualifier', emoji: '🎯', color: '#f1eafe', description: 'Scores inbound leads and books meetings with qualified ones.' },
];

export const BOARD: BoardCard[] = [
  { key: 'TCK-41', title: 'Onboarding email copy', column: 'todo', assigneeId: 'u1', createdBy: 'u3' },
  { key: 'TCK-42', title: 'Pricing page QA', column: 'todo', assigneeId: 'u2', createdBy: 'u2' },
  { key: 'TCK-38', title: 'Q4 roadmap draft', column: 'progress', assigneeId: 'u1', createdBy: 'u1' },
  { key: 'TCK-39', title: 'Fix signup redirect', column: 'progress', assigneeId: 'u4', createdBy: 'u3' },
  { key: 'TCK-36', title: 'Customer interview notes', column: 'review', assigneeId: 'u1', createdBy: 'u2' },
  { key: 'TCK-35', title: 'Export invoices to Docs', column: 'review', assigneeId: 'u2', createdBy: 'u2' },
  { key: 'TCK-31', title: 'Team offsite agenda', column: 'done', assigneeId: 'u3', createdBy: 'u3' },
  { key: 'TCK-30', title: 'Brand color tokens', column: 'done', assigneeId: 'u1', createdBy: 'u4' },
  { key: 'TCK-29', title: 'Release notes v11', column: 'done', assigneeId: 'u4', createdBy: 'u4' },
];

export const boardSamples = (board: BoardCard[]): AccessSample[] =>
  board.map((c) => ({ id: c.key, label: c.title, ownerId: c.assigneeId, createdBy: c.createdBy, shared: false }));

const ticket = (t: Omit<FeedbackTicket, 'id' | 'app' | 'fixedIn'> & { fixedIn?: string }, app = 'ticket-board'): FeedbackTicket => ({
  ...t, id: t.key.toLowerCase(), app, fixedIn: t.fixedIn ?? null,
});

export const TICKETS: FeedbackTicket[] = [
  ticket({ key: 'FB-134', status: 'new', type: 'ux', title: 'Can’t tell who else is editing a ticket', quote: '“Daniel and I overwrote each other’s description”', votes: 3, priority: 'med', reporterId: 'u1', replies: 1 }),
  ticket({ key: 'FB-133', status: 'new', type: 'feat', title: 'Put finished tickets into our weekly wiki notes', quote: '“Every Friday I copy Done tickets into Team Wiki by hand”', votes: 7, priority: 'high', reporterId: 'u3', replies: 1 }),
  ticket({ key: 'FB-132', status: 'new', type: 'feat', title: 'Attach a file from Docs inside a ticket', quote: '“I keep pasting Docs links into comments”', votes: 5, priority: 'med', reporterId: 'u2', replies: 1 }),
  ticket({ key: 'FB-131', status: 'triaged', type: 'feat', title: 'I only want to see my tickets', quote: '“The board has 200 tickets and 5 are mine”', votes: 6, priority: 'high', reporterId: 'u1', replies: 2 }),
  ticket({ key: 'FB-130', status: 'triaged', type: 'bug', title: 'Columns are cut off on mobile', quote: '“Can’t reach the Done column on my phone”', votes: 4, priority: 'med', reporterId: 'u4', replies: 1 }),
  ticket({ key: 'FB-127', status: 'progress', type: 'quality', title: 'Board feels slow with 200+ tickets', quote: '“Takes a few seconds to open”', votes: 3, priority: 'med', reporterId: 'u6', replies: 2 }),
  ticket({ key: 'FB-129', status: 'done', type: 'bug', title: 'Error when moving a ticket to Done', quote: '“Dragged it to Done and got an error”', votes: 3, priority: 'high', reporterId: 'u2', replies: 3, fixedIn: 'v12' }),
  ticket({ key: 'FB-125', status: 'done', type: 'feat', title: 'Share the board link with the team', quote: '“How do I invite the rest of the team?”', votes: 5, priority: 'med', reporterId: 'u3', replies: 2, fixedIn: 'v10' }),
  ticket({ key: 'FB-201', status: 'new', type: 'feat', title: 'Mention people in weekly notes', quote: '“I want to @ someone and have them get a ping”', votes: 2, priority: 'low', reporterId: 'u4', replies: 1 }, 'team-wiki'),
];

export const REPORTS: ImprovementReport[] = [
  {
    id: 'rep-2026-11-11', app: 'ticket-board', createdAt: kst('2026-11-11', '09:00'), author: 'Self-Improvement Agent', messages: 14, valid: 8,
    summary: 'The board works, but people **see too much** (everyone’s tickets) and **copy work between apps by hand** (wiki notes, doc links). Yesterday’s error on moving to Done is fixed in v12. I recommend the 4 changes below.',
    proposals: [
      { id: 'prop-131', reportId: 'rep-2026-11-11', title: 'Members see only their own tickets', body: 'Add an access rule: members view tickets they created or are assigned to. Admins still see everything, and the board opens on “My tickets”.', refs: ['FB-131'], impact: 'High', effort: 'S', affects: 'access rule + board filter', grantId: null, state: 'pending' },
      { id: 'prop-133', reportId: 'rep-2026-11-11', title: 'Write finished tickets into Team Wiki weekly notes', body: 'Connect Ticket Board → Team Wiki over A2A. Every Friday, tickets moved to Done are summarized into that week’s notes page.', refs: ['FB-133'], impact: 'High', effort: 'S', affects: 'new A2A connection', grantId: 'l3', state: 'pending' },
      { id: 'prop-132', reportId: 'rep-2026-11-11', title: 'Attach files from Docs inside a ticket', body: 'Use the existing Docs MCP connection to pick a document and show a live preview inside the ticket.', refs: ['FB-132'], impact: 'Med', effort: 'M', affects: 'ticket screen + Docs MCP', grantId: null, state: 'pending' },
      { id: 'prop-130', reportId: 'rep-2026-11-11', title: 'Columns scroll sideways on phones', body: 'Snap one column per screen width on mobile instead of shrinking every card.', refs: ['FB-130'], impact: 'Med', effort: 'S', affects: 'board layout', grantId: null, state: 'pending' },
    ],
  },
  {
    id: 'rep-2026-11-10', app: 'ticket-board', createdAt: kst('2026-11-10', '09:00'), author: 'Self-Improvement Agent', messages: 9, valid: 4,
    summary: 'Three people hit an **error moving tickets to Done**: the action needs a resolution. The screen held the ticket in place, so nothing was lost.',
    proposals: [
      { id: 'prop-129', reportId: 'rep-2026-11-10', title: 'Ask for a resolution when a ticket enters Done', body: 'Show an inline resolution field when a ticket is dropped on Done, and add a check for the drag.', refs: ['FB-129'], impact: 'High', effort: 'S', affects: 'board drag + QA check', grantId: null, state: 'approved' },
    ],
  },
];

export const GRANTS: Grant[] = [
  { id: 'l1', from: 'ticket-board', to: 'docs', kind: 'MCP', what: 'Attach documents to tickets', status: 'connected', callsPerDay: 38, since: kst('2026-11-06'), proposalId: null },
  { id: 'l2', from: 'team-wiki', to: 'docs', kind: 'MCP', what: 'Embed documents in wiki pages', status: 'connected', callsPerDay: 21, since: kst('2026-11-08'), proposalId: null },
  { id: 'l3', from: 'ticket-board', to: 'team-wiki', kind: 'A2A', what: 'Write finished tickets into weekly notes', status: 'pending', callsPerDay: 0, since: kst('2026-11-11'), proposalId: 'prop-133' },
  { id: 'l4', from: 'agents', to: 'ticket-board', kind: 'MCP', what: 'Members work on tickets from their own AI assistant', status: 'connected', callsPerDay: 64, since: kst('2026-10-20'), proposalId: null },
  { id: 'l5', from: 'agents', to: 'team-wiki', kind: 'MCP', what: 'Members read and write pages from their own AI assistant', status: 'connected', callsPerDay: 27, since: kst('2026-10-25'), proposalId: null },
  { id: 'l6', from: 'agents', to: 'docs', kind: 'MCP', what: 'Members draft documents from their own AI assistant', status: 'connected', callsPerDay: 15, since: kst('2026-11-05'), proposalId: null },
];

export const GRAPH_OVERVIEW: GraphOverview = { people: 12, multiAppPeople: 10, callsDeltaPct: 18 };

const CLAUDE = { id: 'https://claude.ai/.well-known/mcp-client.json', name: 'Claude Desktop', kind: 'claude' } as const;
const CURSOR = { id: 'https://cursor.com/.well-known/mcp-client.json', name: 'Cursor', kind: 'cursor' } as const;

export interface ConsentFixture extends Omit<Consent, 'lastUsedAt'> {
  lastUsedAgo: number;
}

export const CONSENTS: ConsentFixture[] = [
  { id: 'a1', app: 'ticket-board', userId: 'u1', client: { ...CLAUDE }, scopes: ['tickets:read', 'tickets:write', 'comments:write'], grantedAt: kst('2026-11-03'), lastUsedAgo: 2 * MIN },
  { id: 'a2', app: 'ticket-board', userId: 'u2', client: { ...CURSOR }, scopes: ['tickets:read', 'tickets:write'], grantedAt: kst('2026-11-05'), lastUsedAgo: HOUR },
  { id: 'a3', app: 'ticket-board', userId: 'u4', client: { ...CLAUDE }, scopes: ['tickets:read'], grantedAt: kst('2026-11-08'), lastUsedAgo: 3 * DAY },
  { id: 'a4', app: 'team-wiki', userId: 'u1', client: { ...CLAUDE }, scopes: ['pages:read', 'pages:write'], grantedAt: kst('2026-10-25'), lastUsedAgo: 3 * HOUR },
  { id: 'a5', app: 'docs', userId: 'u2', client: { ...CURSOR }, scopes: ['documents:read', 'documents:write'], grantedAt: kst('2026-11-05'), lastUsedAgo: 5 * HOUR },
];

export const TOOL_CALLS: Record<string, (Omit<ToolCall, 'at'> & { time: string })[]> = {
  'ticket-board': [
    { id: 'c1', consentId: 'a1', time: '10:41', tool: 'move_ticket', args: 'TCK-36 → Review', result: 'ok', note: null },
    { id: 'c2', consentId: 'a2', time: '10:12', tool: 'create_ticket', args: '×3', result: 'ok', note: null },
    { id: 'c3', consentId: 'a2', time: '09:58', tool: 'update_ticket', args: 'TCK-38', result: 'denied', note: 'not the assignee · access rule “Members edit own tickets”' },
    { id: 'c4', consentId: 'a1', time: '09:44', tool: 'list_tickets', args: 'status: open', result: 'ok', note: '4 rows · only Mina’s tickets' },
    { id: 'c5', consentId: 'a3', time: '09:30', tool: 'summarize_sprint', args: 'Sprint 14', result: 'ok', note: 'ran the agent graph · $0.04 from app LLM budget' },
  ],
};

const RUNS_14D = [120, 135, 128, 150, 162, 140, 118, 171, 190, 184, 202, 214, 196, 210];
const ERRORS_14D = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0];

const dayBuckets = (count: number, lastDay: string): string[] =>
  Array.from({ length: count }, (_, i) => new Date(new Date(kst(lastDay, '00:00')).getTime() - (count - 1 - i) * DAY).toISOString());

export function metricsFor(app: string, range: MetricsRange, now: number): AppMetrics | null {
  if (app !== 'ticket-board') return null;
  let series: AppMetrics['series'];
  if (range === '14d') {
    series = { buckets: dayBuckets(14, '2026-11-11'), actions: RUNS_14D, errors: ERRORS_14D };
  } else if (range === '30d') {
    const earlier = Array.from({ length: 16 }, (_, i) => 90 + ((i * 37) % 40));
    series = { buckets: dayBuckets(30, '2026-11-11'), actions: [...earlier, ...RUNS_14D], errors: [...earlier.map(() => 0), ...ERRORS_14D] };
  } else {
    const start = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
    series = {
      buckets: Array.from({ length: 24 }, (_, i) => new Date(start + i * HOUR).toISOString()),
      actions: Array.from({ length: 24 }, (_, i) => (i < 7 ? 2 + (i % 3) : 6 + ((i * 7) % 13))),
      errors: Array.from({ length: 24 }, () => 0),
    };
  }
  return {
    range,
    healthy: true,
    activeMembers: { value: 11, total: 12, delta: 2 },
    actionsToday: { value: 210, deltaPct: 7 },
    screenErrors7d: { value: 0, note: '3 caught on Nov 10' },
    agentActionsToday: 106,
    llmBudgetTodayUsd: 0.42,
    series,
    recent: [
      { id: 'r1', action: 'Move TCK-36 → Review', by: 'Mina Kim', status: 'ok', ms: 120, source: 'Mina’s Claude Desktop (MCP)' },
      { id: 'r2', action: 'Create ticket', by: 'Daniel Park', status: 'ok', ms: 90, source: 'App' },
      { id: 'r3', action: 'Attach “Q4 plan.docx”', by: 'Jiwoo Choi', status: 'ok', ms: 310, source: 'Docs (MCP)' },
      { id: 'r4', action: 'Move TCK-42 → Done', by: 'Daniel Park', status: 'blocked', ms: 40, source: 'App' },
      { id: 'r5', action: 'Comment on TCK-39', by: 'Seoyeon Lee', status: 'ok', ms: 70, source: 'App' },
    ],
  };
}

export const QA: Record<string, QaSummary> = {
  'ticket-board': {
    passing: 24,
    total: 24,
    errorsReachedUsers7d: 0,
    checks: [
      { name: 'Create a ticket', status: 'ok', durationMs: 800, note: null },
      { name: 'Edit title and description', status: 'ok', durationMs: 600, note: null },
      { name: 'Drag To do → In progress', status: 'ok', durationMs: 500, note: null },
      { name: 'Drag Review → Done', status: 'ok', durationMs: 700, note: 'Added after FB-129' },
      { name: 'Comment on a ticket', status: 'ok', durationMs: 400, note: null },
      { name: 'Member can’t move someone else’s ticket', status: 'ok', durationMs: 500, note: 'From access rules' },
      { name: 'Board on a 375px phone', status: 'ok', durationMs: 1100, note: null },
      { name: 'Open board with 500 tickets', status: 'ok', durationMs: 1900, note: null },
    ],
    incidents: [
      {
        title: 'Caught: error moving a ticket to Done',
        resolved: true,
        timeline: [
          { when: 'Nov 10 · 14:02', tone: 'red', text: 'Daniel dragged `TCK-28` to Done. The action failed: `resolution` is required.' },
          { when: 'same second', tone: null, text: 'The screen kept the ticket where it was and showed **“Couldn’t move — Retry”**. No blank screen, no lost data.' },
          { when: '14:03', tone: null, text: 'Daniel sent [[/feedback]] → became [[FB-129]]. 2 more people hit it.' },
          { when: 'Nov 11 · 09:00', tone: null, text: 'Daily report proposed: ask for a resolution inline when a ticket enters Done.' },
          { when: '09:12', tone: 'green', text: 'You approved. Fixed in **v12**, new check _Drag Review → Done_ added, 3 people got a reply.' },
        ],
      },
    ],
  },
};

const agent = (id: string, author: string, parts: ChatMessage['parts']): ChatMessage => ({ id, role: 'agent', author, parts });
const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', author: null, parts: [{ kind: 'text', text }] });
const text = (t: string) => ({ kind: 'text' as const, text: t });
const done = (t: string) => ({ kind: 'step' as const, text: t, done: true });

/** Builder threads from the prototype's chat panel, keyed by workspace tab. */
export const THREADS: Partial<Record<WorkspaceTab, ChatMessage[]>> = {
  screen: [
    user('m1', 'Open the board on “My tickets” for members'),
    agent('m2', 'Builder', [done('Added access rule for members'), done('Board opens with My tickets'), text('Ready in Development. **Ship it** when you’re happy.')]),
  ],
  access: [
    user('m1', 'Members should only see their own tickets'),
    agent('m2', 'Builder', [done('Added rule: members view tickets they created or are assigned to'), done('Kept: admins view all tickets'), text('Use **Preview as** to check. Agents acting for a member follow the same rule.')]),
  ],
  qa: [
    agent('m1', 'Builder', [text('Yesterday 3 people hit an error moving tickets to Done. The screen held the ticket in place, so nothing was lost.'), text('It’s fixed in **v12** and I added a check for it. Every deploy now runs 24 checks first.')]),
  ],
  agent: [
    agent('m1', 'Builder', [text('Mina, Daniel and Seoyeon added Ticket Board to their own assistants over MCP.'), text('Each call runs **as them** with their Kelay ID, so the same access rules apply. Their chats stay in their assistant.')]),
  ],
  feedback: [
    agent('m1', 'Self-Improvement Agent', [text('Today’s report is ready: 8 of 14 messages were actionable.'), text('**#2** connects Ticket Board to Team Wiki — approving it adds the connection to your App Graph.')]),
  ],
};
