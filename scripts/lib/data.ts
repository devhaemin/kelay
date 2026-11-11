// Seed data for the Ticket Board scenario. Names, board tickets, feedback, reports and connections
// follow design/prototype/index.html (and apps/console/src/lib/api/fixtures.ts, which mirrors it).

/** Password of every seeded account. Local development only. */
export const PASSWORD = 'kelay-dev-password';
export const ORG = 'orum';
export const HANDLE = 'orum';
export const CONSOLE_APP = 'kelay-console';

export interface Person {
  key: string;
  name: string;
  email: string;
}

export const BUILDER: Person = { key: 'builder', name: 'Jeongyun Lee', email: 'jeongyun@orum.test' };

export interface TeamMember extends Person {
  role: 'admin' | 'member' | 'guest';
}

export const TEAM = [
  { key: 'seoyeon', name: 'Seoyeon Lee', email: 'seoyeon@orum.test', role: 'admin' },
  { key: 'junho', name: 'Junho Park', email: 'junho@orum.test', role: 'member' },
  { key: 'hyunwoo', name: 'Hyunwoo Jang', email: 'hyunwoo@orum.test', role: 'guest' },
  { key: 'mina', name: 'Mina Kim', email: 'mina@orum.test', role: 'member' },
  { key: 'daniel', name: 'Daniel Park', email: 'daniel@orum.test', role: 'member' },
] as const satisfies readonly TeamMember[];

export type TeamKey = (typeof TEAM)[number]['key'];

export const APPS = [
  { slug: 'ticket-board', name: 'Ticket Board', emoji: '🎫', color: '#e3ecff', description: 'Jira-style board for the team’s tasks. Built from one paragraph.' },
  { slug: 'team-wiki', name: 'Team Wiki', emoji: '📚', color: '#e6f6ec', description: 'Notion-style pages for specs, decisions and weekly notes.' },
  { slug: 'docs', name: 'Docs', emoji: '📄', color: '#fdf3e1', description: 'Office documents — write, review and share files with the team.' },
] as const;

export const GRANTS = [
  { fromApp: 'ticket-board', toApp: 'docs', kind: 'MCP', purpose: 'Attach documents to tickets', connected: true, calls: 38 },
  { fromApp: 'team-wiki', toApp: 'docs', kind: 'MCP', purpose: 'Embed documents in wiki pages', connected: true, calls: 21 },
  { fromApp: 'ticket-board', toApp: 'team-wiki', kind: 'A2A', purpose: 'Write finished tickets into weekly notes', connected: false, calls: 0 },
] as const;

/** An assistant a member connected to the app, as the Agent tab lists it. */
export const CONSENTS = [
  { user: 'mina', app: 'ticket-board', clientId: 'https://claude.ai/.well-known/mcp-client.json', clientName: 'Claude Desktop', scopes: ['offline_access'] },
  { user: 'daniel', app: 'ticket-board', clientId: 'https://cursor.com/.well-known/mcp-client.json', clientName: 'Cursor', scopes: ['offline_access'] },
] as const satisfies readonly { user: TeamKey; app: string; clientId: string; clientName: string; scopes: string[] }[];

// ---------------------------------------------------------------- app database rows

const id = (group: number, n: number) => `00000000-0000-4000-8${group}00-${String(n).padStart(12, '0')}`;

export const PROJECTS = [
  { id: id(1, 1), name: 'Q4 launch', startsInDays: -40, endsInDays: 20 },
  { id: id(1, 2), name: 'Website refresh', startsInDays: -10, endsInDays: 45 },
] as const;

export interface BoardTicket {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'review' | 'done';
  assignee: TeamKey;
  createdBy: TeamKey;
  shared: boolean;
  dueInDays: number;
  project: number;
}

/** The prototype's board. Junho is assigned three tickets and two more are shared with the whole team. */
export const BOARD: BoardTicket[] = [
  { id: id(2, 41), title: 'Onboarding email copy', status: 'todo', assignee: 'junho', createdBy: 'seoyeon', shared: false, dueInDays: 3, project: 0 },
  { id: id(2, 42), title: 'Pricing page QA', status: 'todo', assignee: 'daniel', createdBy: 'daniel', shared: false, dueInDays: 5, project: 1 },
  { id: id(2, 38), title: 'Q4 roadmap draft', status: 'doing', assignee: 'junho', createdBy: 'junho', shared: false, dueInDays: -1, project: 0 },
  { id: id(2, 39), title: 'Fix signup redirect', status: 'doing', assignee: 'seoyeon', createdBy: 'seoyeon', shared: true, dueInDays: 1, project: 1 },
  { id: id(2, 36), title: 'Customer interview notes', status: 'review', assignee: 'junho', createdBy: 'daniel', shared: false, dueInDays: 0, project: 0 },
  { id: id(2, 35), title: 'Export invoices to Docs', status: 'review', assignee: 'daniel', createdBy: 'daniel', shared: false, dueInDays: 2, project: 0 },
  { id: id(2, 31), title: 'Team offsite agenda', status: 'done', assignee: 'seoyeon', createdBy: 'seoyeon', shared: true, dueInDays: -5, project: 0 },
  { id: id(2, 30), title: 'Brand color tokens', status: 'done', assignee: 'mina', createdBy: 'seoyeon', shared: false, dueInDays: -4, project: 1 },
  { id: id(2, 29), title: 'Release notes v11', status: 'done', assignee: 'seoyeon', createdBy: 'seoyeon', shared: false, dueInDays: -7, project: 0 },
];

/** A shared ticket of another org in the same database: no orum member may ever see it. */
export const FOREIGN_TICKET = { id: id(2, 999), org: 'other-team', title: 'Another team’s secret ticket' } as const;

export const COMMENTS: { id: string; ticket: string; author: TeamKey; body: string }[] = [
  { id: id(3, 1), ticket: id(2, 39), author: 'seoyeon', body: 'Redirect loses the invite code. Repro on Safari.' },
  { id: id(3, 2), ticket: id(2, 39), author: 'junho', body: 'I can pair on this after the roadmap draft.' },
  { id: id(3, 3), ticket: id(2, 36), author: 'daniel', body: 'Notes from the three calls are in Docs.' },
];

// ---------------------------------------------------------------- control DB: feedback and reports

export interface FeedbackSeed {
  app: string;
  key: string;
  status: 'new' | 'triaged' | 'progress' | 'done';
  type: 'bug' | 'ux' | 'feat' | 'quality';
  title: string;
  text: string;
  votes: number;
  priority: 'high' | 'med' | 'low';
  reporter: TeamKey;
  replies: number;
  fixedIn?: string;
  ageHours: number;
}

export const FEEDBACK: FeedbackSeed[] = [
  { app: 'ticket-board', key: 'FB-125', status: 'done', type: 'feat', title: 'Share the board link with the team', text: 'How do I invite the rest of the team?', votes: 5, priority: 'med', reporter: 'junho', replies: 2, fixedIn: 'v10', ageHours: 140 },
  { app: 'ticket-board', key: 'FB-127', status: 'progress', type: 'quality', title: 'Board feels slow with 200+ tickets', text: 'Takes a few seconds to open', votes: 3, priority: 'med', reporter: 'hyunwoo', replies: 2, ageHours: 96 },
  { app: 'ticket-board', key: 'FB-129', status: 'done', type: 'bug', title: 'Error when moving a ticket to Done', text: 'Dragged it to Done and got an error', votes: 3, priority: 'high', reporter: 'daniel', replies: 3, fixedIn: 'v12', ageHours: 44 },
  { app: 'ticket-board', key: 'FB-130', status: 'triaged', type: 'bug', title: 'Columns are cut off on mobile', text: 'Can’t reach the Done column on my phone', votes: 4, priority: 'med', reporter: 'seoyeon', replies: 1, ageHours: 30 },
  { app: 'ticket-board', key: 'FB-131', status: 'triaged', type: 'feat', title: 'I only want to see my tickets', text: 'The board has 200 tickets and 5 are mine', votes: 6, priority: 'high', reporter: 'mina', replies: 2, ageHours: 26 },
  { app: 'ticket-board', key: 'FB-132', status: 'new', type: 'feat', title: 'Attach a file from Docs inside a ticket', text: 'I keep pasting Docs links into comments', votes: 5, priority: 'med', reporter: 'daniel', replies: 1, ageHours: 8 },
  { app: 'ticket-board', key: 'FB-133', status: 'new', type: 'feat', title: 'Put finished tickets into our weekly wiki notes', text: 'Every Friday I copy Done tickets into Team Wiki by hand', votes: 7, priority: 'high', reporter: 'junho', replies: 1, ageHours: 5 },
  { app: 'ticket-board', key: 'FB-134', status: 'new', type: 'ux', title: 'Can’t tell who else is editing a ticket', text: 'Daniel and I overwrote each other’s description', votes: 3, priority: 'med', reporter: 'mina', replies: 1, ageHours: 2 },
  { app: 'team-wiki', key: 'FB-201', status: 'new', type: 'feat', title: 'Mention people in weekly notes', text: 'I want to @ someone and have them get a ping', votes: 2, priority: 'low', reporter: 'seoyeon', replies: 1, ageHours: 20 },
];

export interface ProposalSeed {
  title: string;
  body: string;
  refs: string[];
  impact: 'High' | 'Med' | 'Low';
  effort: 'S' | 'M' | 'L';
  affects: string;
  status: 'pending' | 'built';
}

export interface ReportSeed {
  app: string;
  ageHours: number;
  received: number;
  valid: number;
  summary: string;
  proposals: ProposalSeed[];
}

export const REPORTS: ReportSeed[] = [
  {
    app: 'ticket-board',
    ageHours: 25,
    received: 9,
    valid: 4,
    summary: 'Three people hit an **error moving tickets to Done**: the action needs a resolution. The screen held the ticket in place, so nothing was lost.',
    proposals: [
      { title: 'Ask for a resolution when a ticket enters Done', body: 'Show an inline resolution field when a ticket is dropped on Done, and add a check for the drag.', refs: ['FB-129'], impact: 'High', effort: 'S', affects: 'board drag + QA check', status: 'built' },
    ],
  },
  {
    app: 'ticket-board',
    ageHours: 1,
    received: 14,
    valid: 8,
    summary: 'The board works, but people **see too much** (everyone’s tickets) and **copy work between apps by hand** (wiki notes, doc links). Yesterday’s error on moving to Done is fixed in v12. I recommend the 4 changes below.',
    proposals: [
      { title: 'Members see only their own tickets', body: 'Add an access rule: members view tickets they created or are assigned to. Admins still see everything, and the board opens on “My tickets”.', refs: ['FB-131'], impact: 'High', effort: 'S', affects: 'access rule + board filter', status: 'pending' },
      { title: 'Write finished tickets into Team Wiki weekly notes', body: 'Connect Ticket Board → Team Wiki over A2A. Every Friday, tickets moved to Done are summarized into that week’s notes page.', refs: ['FB-133'], impact: 'High', effort: 'S', affects: 'new A2A connection', status: 'pending' },
      { title: 'Attach files from Docs inside a ticket', body: 'Use the existing Docs MCP connection to pick a document and show a live preview inside the ticket.', refs: ['FB-132'], impact: 'Med', effort: 'M', affects: 'ticket screen + Docs MCP', status: 'pending' },
      { title: 'Columns scroll sideways on phones', body: 'Snap one column per screen width on mobile instead of shrinking every card.', refs: ['FB-130'], impact: 'Med', effort: 'S', affects: 'board layout', status: 'pending' },
    ],
  },
];
