// What the console screens read and change. Implemented by the mock (fixtures) and by the
// Control API client. Timestamps are ISO-8601 strings; screens format them.
import type { AppSchema, Op, PolicyMatrix, Scope } from '@kelay/contracts';

export type { AppSchema, Op, PolicyMatrix, Scope };

export type AppStatus = 'live' | 'draft' | 'paused';
export type Env = 'dev' | 'prod';

export interface Builder {
  name: string;
  handle: string;
  email: string;
  /** Team whose people use the builder's apps. */
  team: string;
}

export interface AppSummary {
  id: string;
  handle: string;
  name: string;
  emoji: string;
  color: string;
  description: string;
  status: AppStatus;
  users: number;
  /** Actions run in the last 30 days; null before the first run. */
  runs: number | null;
  newFeedback: number;
  updatedAt: string;
}

export interface PendingChange {
  title: string;
  count: number;
}

export interface AppDetail extends AppSummary {
  /** Public production URL (`/<handle>/<app>` on the app domain). */
  productionUrl: string;
  /** MCP endpoint served by the gateway (contracts §7). */
  mcpEndpoint: string;
  /** Dev preview URL while a Builder workspace is running. */
  previewUrl: string | null;
  /** Version currently live in production, e.g. "v12". */
  version: string | null;
  pendingChange: PendingChange | null;
}

export type MemberStatus = 'active' | 'unconfirmed' | 'banned';
export type Provider = 'google' | 'email' | 'kakao' | 'github';

export interface Member {
  userId: string;
  name: string;
  email: string;
  /** A role from the app's AppSchema. */
  role: string;
  plan: string;
  status: MemberStatus;
  /** Null when the API does not say how the member signs in. */
  provider: Provider | null;
  /** Null when the API does not record when the member joined. */
  createdAt: string | null;
  lastSignInAt: string | null;
  /** Name of the AI assistant connected over MCP, if any. */
  assistant: string | null;
  /** The member's roles in the builder's other apps (one Kelay ID). */
  otherApps: { app: string; name: string; role: string }[];
  color?: string;
}

export interface MemberPatch {
  role?: string;
  status?: MemberStatus;
  plan?: string;
}

export type TicketStatus = 'new' | 'triaged' | 'progress' | 'done';
export type TicketType = 'bug' | 'ux' | 'feat' | 'quality';
export type Priority = 'high' | 'med' | 'low';

export interface FeedbackTicket {
  id: string;
  key: string;
  app: string;
  status: TicketStatus;
  type: TicketType;
  title: string;
  quote: string;
  votes: number;
  priority: Priority;
  reporterId: string;
  replies: number;
  fixedIn: string | null;
}

export interface TicketPatch {
  status?: TicketStatus;
  priority?: Priority;
}

/** A message under a ticket, after the reporter's own. */
export interface TicketReply {
  id: string;
  /** Who wrote it, as shown above the bubble: "Kelay · auto-reply", "Jeongyun Lee · reply". */
  who: string;
  text: string;
  at: string | null;
}

export type ProposalState = 'pending' | 'approved' | 'rejected';

export interface Proposal {
  id: string;
  reportId: string;
  title: string;
  body: string;
  refs: string[];
  impact: 'High' | 'Med' | 'Low';
  effort: 'S' | 'M' | 'L';
  affects: string;
  /** Grant this proposal creates when approved (an app-to-app connection). */
  grantId: string | null;
  state: ProposalState;
}

export interface ImprovementReport {
  id: string;
  app: string;
  createdAt: string;
  author: string;
  messages: number;
  valid: number;
  /** Uses `**bold**` for emphasis. */
  summary: string;
  proposals: Proposal[];
}

export interface ProposalDecision {
  proposal: Proposal;
  /** The grant the decision changed, when the proposal carries one. */
  grant: Grant | null;
}

/** Graph node id: an app slug, or one of the two platform nodes. */
export type NodeId = string;
export const AGENTS_NODE = 'agents';
export const IDENTITY_NODE = 'id';

export type GrantKind = 'MCP' | 'A2A';
export type GrantStatus = 'pending' | 'connected' | 'paused' | 'rejected';

export interface Grant {
  id: string;
  from: NodeId;
  to: NodeId;
  kind: GrantKind;
  what: string;
  status: GrantStatus;
  callsPerDay: number;
  /** Requested at while pending, approved at once connected. */
  since: string;
  proposalId: string | null;
}

export interface GrantRequest {
  from: NodeId;
  to: NodeId;
  kind: GrantKind;
  what: string;
}

export type AssistantKind = 'claude' | 'cursor' | 'other';

export interface Consent {
  id: string;
  app: string;
  userId: string;
  client: { id: string; name: string; kind: AssistantKind };
  /** `collection:op`, e.g. `tickets:read`. */
  scopes: string[];
  grantedAt: string;
  lastUsedAt: string | null;
}

export interface ToolCall {
  id: string;
  /** Null when the member's consent for that assistant was never recorded. */
  consentId: string | null;
  at: string;
  tool: string;
  args: string;
  result: 'ok' | 'denied' | 'error';
  note: string | null;
  /** The member the assistant acted for, and the assistant's name; the consent has both when they are absent. */
  userId?: string | null;
  clientName?: string | null;
}

export interface DeployResult {
  app: string;
  env: Env;
  version: string;
  status: 'live' | 'failed';
  url: string;
  durationMs: number;
}

export interface PolicyNote {
  role: string;
  collection: string;
  op: Op;
  /** Ticket the rule came from, e.g. FB-131. */
  from: string;
}

export interface AppPolicy {
  schema: AppSchema;
  /** The rules as the builder last saved them: the draft when there is one, else the deployed rules. */
  matrix: PolicyMatrix;
  notes: PolicyNote[];
  /** Version whose rules are deployed to Development, e.g. "v3". */
  version: string | null;
  /** Rules saved and not deployed yet; they go live with the next deploy to Development. */
  draft: { version: string; savedAt: string } | null;
}

/** A row "Preview as" shows: one the member can read. */
export interface AccessSample {
  id: string;
  label: string;
  ownerId: string | null;
  createdBy: string | null;
  shared: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
}

export interface AccessPreviewCollection {
  collection: string;
  label: string;
  /** Rows the member can read, edit and delete. */
  readable: number;
  editable: number;
  deletable: number;
  canCreate: boolean;
  /** Rows in the collection, when known. */
  total: number | null;
  /** Newest readable rows (the API caps the list). */
  rows: AccessSample[];
}

/** What one member can see and do, evaluated with the deployed rules. */
export interface AccessPreview {
  userId: string;
  role: string;
  /** Version whose rules were applied, e.g. "v3"; null when the preview follows the saved rules. */
  version: string | null;
  collections: AccessPreviewCollection[];
}

export type MetricsRange = '24h' | '14d' | '30d';

export interface AppMetrics {
  range: MetricsRange;
  healthy: boolean;
  activeMembers: { value: number; total: number; delta: number };
  actionsToday: { value: number; deltaPct: number };
  screenErrors7d: { value: number; note: string | null };
  agentActionsToday: number;
  llmBudgetTodayUsd: number;
  /** One bucket per hour for 24h, per day otherwise. */
  series: { buckets: string[]; actions: number[]; errors: number[] };
  recent: RecentAction[];
}

export interface RecentAction {
  id: string;
  action: string;
  /** A member's name or user id; empty when nobody was signed in. */
  by: string;
  status: 'ok' | 'blocked' | 'error';
  ms: number;
  source: string;
  args?: string | null;
  at?: string | null;
}

export interface QaCheck {
  name: string;
  status: 'ok' | 'bad' | 'wait';
  durationMs: number;
  note: string | null;
  /** Set on checks generated from the access rules. */
  role?: string | null;
}

export interface QaIncident {
  title: string;
  resolved: boolean;
  /** `when` is an ISO timestamp or ready-made text. `text` uses `**bold**`, `` `mono` ``, `[[ref]]` and `_italic_`. */
  timeline: { when: string; tone: 'red' | 'green' | null; text: string }[];
}

export interface QaSummary {
  passing: number;
  total: number;
  errorsReachedUsers7d: number;
  checks: QaCheck[];
  incidents: QaIncident[];
  /** Why the last run could not finish; null or absent when it did. */
  error?: string | null;
  /** Version the run checked, and when it finished. */
  version?: string | null;
  finishedAt?: string | null;
}

export interface GraphOverview {
  people: number;
  multiAppPeople: number;
  callsDeltaPct: number | null;
}

export type ChatPart = { kind: 'text'; text: string } | { kind: 'step'; text: string; done: boolean };

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  author: string | null;
  parts: ChatPart[];
}

export type Preview =
  | { kind: 'url'; url: string }
  | { kind: 'fixture'; board: BoardCard[] }
  | null;

/** A card on the Ticket Board fixture preview (mock mode only). */
export interface BoardCard {
  key: string;
  title: string;
  column: 'todo' | 'progress' | 'review' | 'done';
  assigneeId: string;
  createdBy: string;
}

/** Workspace tab a Builder thread is scoped to. */
export type WorkspaceTab = 'screen' | 'access' | 'qa' | 'agent' | 'feedback' | 'users' | 'monitoring';

export interface ConsoleApi {
  readonly mode: 'mock' | 'http';

  getMe(): Promise<Builder>;

  listApps(): Promise<AppSummary[]>;
  getApp(app: string): Promise<AppDetail>;
  createApp(input: { prompt: string }): Promise<AppSummary>;
  getPreview(app: string): Promise<Preview>;

  listMembers(app: string): Promise<Member[]>;
  updateMember(app: string, userId: string, patch: MemberPatch): Promise<Member>;
  removeMember(app: string, userId: string): Promise<void>;
  sendPasswordRecovery(app: string, userId: string): Promise<void>;

  listTickets(app: string): Promise<FeedbackTicket[]>;
  updateTicket(app: string, key: string, patch: TicketPatch): Promise<FeedbackTicket>;
  /** Replies under a ticket, oldest first. */
  getTicketThread(app: string, key: string): Promise<TicketReply[]>;
  replyToTicket(app: string, key: string, text: string): Promise<TicketReply>;

  /** Newest first. */
  listReports(app: string): Promise<ImprovementReport[]>;
  runReport(app: string): Promise<ImprovementReport>;
  approveProposal(id: string): Promise<ProposalDecision>;
  rejectProposal(id: string): Promise<ProposalDecision>;
  reopenProposal(id: string): Promise<ProposalDecision>;

  listGrants(): Promise<Grant[]>;
  requestGrant(input: GrantRequest): Promise<Grant>;
  allowGrant(id: string): Promise<Grant>;
  rejectGrant(id: string): Promise<Grant>;
  getGraphOverview(): Promise<GraphOverview | null>;

  /** Assistants members connected to one app, or to any of the builder's apps. */
  listConsents(app?: string): Promise<Consent[]>;
  revokeConsent(app: string, id: string): Promise<void>;
  listToolCalls(app: string): Promise<ToolCall[]>;

  deploy(app: string, env: Env): Promise<DeployResult>;
  publish(app: string): Promise<DeployResult>;

  getPolicy(app: string): Promise<AppPolicy>;
  savePolicy(app: string, matrix: PolicyMatrix): Promise<AppPolicy>;
  /** Null when the app has no database to preview against, or the user is not a member. */
  previewAccess(app: string, userId: string): Promise<AccessPreview | null>;

  getMetrics(app: string, range: MetricsRange): Promise<AppMetrics | null>;
  /** The latest QA run; null before the first one. */
  getQa(app: string): Promise<QaSummary | null>;
  runQa(app: string): Promise<QaSummary>;

  getBuilderThread(app: string, tab: WorkspaceTab): Promise<ChatMessage[]>;
  sendBuilderMessage(app: string, tab: WorkspaceTab, text: string): Promise<ChatMessage[]>;
}
