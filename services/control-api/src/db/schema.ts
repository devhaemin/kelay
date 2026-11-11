// Control DB (docs/infrastructure.md §7). drizzle-kit generates the SQL in ../../migrations from this file.
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AppSchema, Op, PolicyMatrix } from '@kelay/contracts';

export const APP_STATUSES = ['draft', 'live', 'paused', 'archived'] as const;
export const ENV_NAMES = ['dev', 'prod'] as const;
export const MEMBER_STATUSES = ['active', 'unconfirmed', 'banned'] as const;
export const GRANT_KINDS = ['MCP', 'A2A'] as const;
export const GRANT_STATUSES = ['pending', 'connected', 'rejected'] as const;
export const TICKET_TYPES = ['bug', 'ux', 'feat', 'quality'] as const;
export const TICKET_SOURCES = ['in-app', 'email', 'chat', 'auto'] as const;
export const TICKET_STATUSES = ['new', 'triaged', 'progress', 'done'] as const;
export const PRIORITIES = ['high', 'med', 'low'] as const;
export const IMPACTS = ['High', 'Med', 'Low'] as const;
export const EFFORTS = ['S', 'M', 'L'] as const;
export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'built'] as const;
export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export const VERSION_STATUSES = ['draft', 'deployed'] as const;
export const ACTION_STATUSES = ['ok', 'blocked', 'error'] as const;
export const CALLER_KINDS = ['user', 'agent', 'app'] as const;
export const QA_STATUSES = ['passed', 'failed', 'error'] as const;

export type AppStatus = (typeof APP_STATUSES)[number];
export type EnvName = (typeof ENV_NAMES)[number];
export type MemberStatus = (typeof MEMBER_STATUSES)[number];
export type GrantKind = (typeof GRANT_KINDS)[number];
export type GrantStatus = (typeof GRANT_STATUSES)[number];
export type TicketType = (typeof TICKET_TYPES)[number];
export type TicketSource = (typeof TICKET_SOURCES)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Impact = (typeof IMPACTS)[number];
export type Effort = (typeof EFFORTS)[number];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export type CallerKind = (typeof CALLER_KINDS)[number];
export type QaStatus = (typeof QA_STATUSES)[number];

/** Cloud resources a deploy produced; empty for the local driver. */
export interface DeployResources {
  functionName?: string;
  functionArn?: string;
  functionUrl?: string;
  nodeFunctionName?: string;
  nodeLambdaVersion?: string;
  stateMachineArns?: string[];
}

export interface GraphDefinition {
  /** GraphSpec.name; the state machine is `kelay-app-<app>-<env>-<name>`. */
  name: string;
  /** Amazon States Language JSON from @kelay/graph. `${NodeFunctionArn}` is replaced with the node function alias ARN. */
  definition: string;
  type?: 'EXPRESS' | 'STANDARD';
}

/** One node invocation of an agent-graph run, as the run orchestrator reports it. */
export interface RunNode {
  node: string;
  status: 'ok' | 'error' | 'timeout' | 'aborted';
  ms: number;
  /** 1 on the first try. */
  attempt?: number;
  /** Review rejections before this invocation. */
  loop?: number;
  costUsd?: number;
}

/** One access check of a QA run: does `role` get the expected answer for `op` on `collection`? */
export interface QaCheckResult {
  role: string;
  collection: string;
  op: Op;
  expected: 'allow' | 'deny';
  /** `error` when the check itself could not run. */
  actual: 'allow' | 'deny' | 'error';
  ok: boolean;
  ms: number;
  note: string | null;
}

export interface ReportStats {
  window: { from: string; to: string };
  received: number;
  valid: number;
  mergedOrNoise: number;
  open: number;
  byType: Record<string, number>;
  byPriority: Record<string, number>;
  metrics: Record<string, number | string>;
}

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));
const tstz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => tstz('created_at').notNull().defaultNow();

export const builders = pgTable('builders', {
  userId: text('user_id').primaryKey(),
  handle: text('handle').notNull().unique(),
  createdAt: createdAt(),
});

export const apps = pgTable(
  'apps',
  {
    slug: text('slug').primaryKey(),
    handle: text('handle').notNull(),
    owner: text('owner')
      .notNull()
      .references(() => builders.userId),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    emoji: text('emoji'),
    color: text('color'),
    status: text('status').$type<AppStatus>().notNull().default('draft'),
    /** Store page setting: only live apps that are listed appear on /public/v1/stores/:handle. */
    listed: boolean('listed').notNull().default(true),
    ticketSeq: integer('ticket_seq').notNull().default(0),
    versionSeq: integer('version_seq').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('apps_status_check', sql`${t.status} in (${oneOf(APP_STATUSES)})`),
    index('apps_owner_idx').on(t.owner),
    index('apps_handle_idx').on(t.handle),
  ],
);

export const versions = pgTable(
  'versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    app: text('app')
      .notNull()
      .references(() => apps.slug, { onDelete: 'cascade' }),
    env: text('env').$type<EnvName>().notNull(),
    /** App-wide version number shown as `v12`; a publish to prod keeps the number of the version it promotes. */
    number: integer('number').notNull(),
    codeCommit: text('code_commit').notNull(),
    /** The web function's bundle. */
    artifactUrl: text('artifact_url').notNull(),
    /** The node function's bundle. Null for a build that put both handlers in `artifactUrl`, or has no nodes. */
    nodesArtifactUrl: text('nodes_artifact_url'),
    configVersion: text('config_version').notNull(),
    lambdaVersion: text('lambda_version').notNull(),
    resources: jsonb('resources').$type<DeployResources>().notNull().default({}),
    schema: jsonb('schema').$type<AppSchema>(),
    policy: jsonb('policy').$type<PolicyMatrix>(),
    /** Kept so a publish can recreate the same state machines in prod. */
    graphs: jsonb('graphs').$type<GraphDefinition[]>().notNull().default([]),
    /**
     * `draft` holds access rules saved in the console and not deployed yet: a copy of the dev version it
     * was edited from, with the new policy. Deploying to dev turns the draft into that deployed version.
     */
    status: text('status').$type<VersionStatus>().notNull().default('deployed'),
    /** Where the app-runtime caller token minted for this deploy is kept; never the token itself. */
    callerTokenRef: text('caller_token_ref'),
    sourceVersionId: uuid('source_version_id').references((): AnyPgColumn => versions.id, { onDelete: 'set null' }),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('versions_env_check', sql`${t.env} in (${oneOf(ENV_NAMES)})`),
    check('versions_status_check', sql`${t.status} in (${oneOf(VERSION_STATUSES)})`),
    uniqueIndex('versions_one_draft_idx').on(t.app, t.env).where(sql`${t.status} = 'draft'`),
    uniqueIndex('versions_app_env_number_idx').on(t.app, t.env, t.number),
  ],
);

export const envs = pgTable(
  'envs',
  {
    app: text('app')
      .notNull()
      .references(() => apps.slug, { onDelete: 'cascade' }),
    name: text('name').$type<EnvName>().notNull(),
    activeVersionId: uuid('active_version_id').references((): AnyPgColumn => versions.id, { onDelete: 'set null' }),
    databaseUrl: text('database_url'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.app, t.name] }), check('envs_name_check', sql`${t.name} in (${oneOf(ENV_NAMES)})`)],
);

/** Contract §9: identity reads this table; keep the columns exactly as documented. */
export const appMembers = pgTable(
  'app_members',
  {
    app: text('app').notNull(),
    userId: text('user_id').notNull(),
    org: text('org').notNull(),
    role: text('role').notNull(),
    plan: text('plan').notNull(),
    status: text('status').$type<MemberStatus>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.app, t.userId] })],
);

export const grants = pgTable(
  'grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromApp: text('from_app')
      .notNull()
      .references(() => apps.slug, { onDelete: 'cascade' }),
    toApp: text('to_app')
      .notNull()
      .references(() => apps.slug, { onDelete: 'cascade' }),
    kind: text('kind').$type<GrantKind>().notNull(),
    purpose: text('purpose').notNull(),
    status: text('status').$type<GrantStatus>().notNull().default('pending'),
    calls: integer('calls').notNull().default(0),
    requestedBy: text('requested_by').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: tstz('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [
    check('grants_kind_check', sql`${t.kind} in (${oneOf(GRANT_KINDS)})`),
    check('grants_status_check', sql`${t.status} in (${oneOf(GRANT_STATUSES)})`),
    check('grants_distinct_apps_check', sql`${t.fromApp} <> ${t.toApp}`),
    uniqueIndex('grants_open_link_idx').on(t.fromApp, t.toApp, t.kind).where(sql`${t.status} <> 'rejected'`),
    index('grants_to_app_idx').on(t.toApp),
  ],
);

export const consents = pgTable(
  'consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    app: text('app')
      .notNull()
      .references(() => apps.slug, { onDelete: 'cascade' }),
    /** MCP client id: the client's CIMD URL. */
    clientId: text('client_id').notNull(),
    clientName: text('client_name'),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    lastUsedAt: tstz('last_used_at'),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    uniqueIndex('consents_active_idx').on(t.userId, t.app, t.clientId).where(sql`${t.revokedAt} is null`),
    index('consents_app_idx').on(t.app),
  ],
);

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    app: text('app')
      .notNull()
      .references(() => apps.slug, { onDelete: 'cascade' }),
    /** `FB-<n>`, numbered per app. */
    key: text('key').notNull(),
    type: text('type').$type<TicketType>(),
    title: text('title').notNull(),
    text: text('text').notNull(),
    route: text('route'),
    context: jsonb('context'),
    source: text('source').$type<TicketSource>().notNull().default('in-app'),
    votes: integer('votes').notNull().default(1),
    status: text('status').$type<TicketStatus>().notNull().default('new'),
    priority: text('priority').$type<Priority>(),
    /** null until triaged; false marks noise, which list views and reports leave out. */
    valid: boolean('valid'),
    duplicateOf: uuid('duplicate_of').references((): AnyPgColumn => tickets.id, { onDelete: 'set null' }),
    reporter: text('reporter'),
    reporterOrg: text('reporter_org'),
    fixedIn: text('fixed_in'),
    triagedAt: tstz('triaged_at'),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('tickets_type_check', sql`${t.type} is null or ${t.type} in (${oneOf(TICKET_TYPES)})`),
    check('tickets_source_check', sql`${t.source} in (${oneOf(TICKET_SOURCES)})`),
    check('tickets_status_check', sql`${t.status} in (${oneOf(TICKET_STATUSES)})`),
    check('tickets_priority_check', sql`${t.priority} is null or ${t.priority} in (${oneOf(PRIORITIES)})`),
    uniqueIndex('tickets_app_key_idx').on(t.app, t.key),
    index('tickets_app_status_idx').on(t.app, t.status),
    index('tickets_text_trgm_idx').using('gin', t.text.op('gin_trgm_ops')),
  ],
);

export const ticketEvents = pgTable(
  'ticket_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    actor: text('actor'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('ticket_events_ticket_idx').on(t.ticketId, t.createdAt)],
);

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    app: text('app')
      .notNull()
      .references(() => apps.slug, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    summary: text('summary').notNull(),
    stats: jsonb('stats').$type<ReportStats>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('reports_app_created_idx').on(t.app, t.createdAt)],
);

export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    app: text('app')
      .notNull()
      .references(() => apps.slug, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Ticket keys (`FB-131`) the proposal answers. */
    refs: text('refs').array().notNull().default(sql`'{}'::text[]`),
    impact: text('impact').$type<Impact>().notNull(),
    effort: text('effort').$type<Effort>().notNull(),
    affects: text('affects').notNull(),
    status: text('status').$type<ProposalStatus>().notNull().default('pending'),
    decidedBy: text('decided_by'),
    decidedAt: tstz('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [
    check('proposals_impact_check', sql`${t.impact} in (${oneOf(IMPACTS)})`),
    check('proposals_effort_check', sql`${t.effort} in (${oneOf(EFFORTS)})`),
    check('proposals_status_check', sql`${t.status} in (${oneOf(PROPOSAL_STATUSES)})`),
    index('proposals_report_idx').on(t.reportId, t.position),
  ],
);

export const improvementRuns = pgTable(
  'improvement_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposals.id, { onDelete: 'cascade' }),
    app: text('app')
      .notNull()
      .references(() => apps.slug, { onDelete: 'cascade' }),
    status: text('status').$type<RunStatus>().notNull().default('queued'),
    worker: text('worker'),
    branch: text('branch'),
    versionId: uuid('version_id').references(() => versions.id, { onDelete: 'set null' }),
    error: text('error'),
    createdAt: createdAt(),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    check('improvement_runs_status_check', sql`${t.status} in (${oneOf(RUN_STATUSES)})`),
    index('improvement_runs_queue_idx').on(t.status, t.createdAt),
    index('improvement_runs_proposal_idx').on(t.proposalId),
  ],
);

export const sandboxes = pgTable(
  'sandboxes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskArn: text('task_arn').notNull().unique(),
    owner: text('owner').notNull(),
    app: text('app').references(() => apps.slug, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('running'),
    lastActive: tstz('last_active').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    check('sandboxes_kind_check', sql`${t.kind} in ('workspace', 'improvement')`),
    index('sandboxes_owner_idx').on(t.owner),
  ],
);

export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    app: text('app')
      .notNull()
      .references(() => apps.slug, { onDelete: 'cascade' }),
    env: text('env').$type<EnvName>().notNull(),
    scope: text('scope').notNull(),
    /** Plan name or user id for the `plan` and `user` scopes; empty for `app`. */
    subject: text('subject').notNull().default(''),
    period: text('period').notNull(),
    limitUsd: numeric('limit_usd', { precision: 12, scale: 4 }).notNull(),
    spentUsd: numeric('spent_usd', { precision: 12, scale: 4 }).notNull().default('0'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('budgets_env_check', sql`${t.env} in (${oneOf(ENV_NAMES)})`),
    check('budgets_scope_check', sql`${t.scope} in ('app', 'plan', 'user')`),
    check('budgets_period_check', sql`${t.period} in ('day', 'month')`),
    uniqueIndex('budgets_subject_idx').on(t.app, t.env, t.scope, t.subject, t.period),
  ],
);

/**
 * One thing done in an app: a screen action, a tool call from a member's assistant, or a call from
 * another app. Monitoring and the Agent tab read this table; services record into it through
 * POST /internal/v1/runs and POST /internal/v1/mcp-calls.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    app: text('app')
      .notNull()
      .references(() => apps.slug, { onDelete: 'cascade' }),
    env: text('env').$type<EnvName>().notNull().default('prod'),
    /** Action or tool name, e.g. `tickets_update` or `summarize_overdue`. */
    action: text('action').notNull(),
    /** Short summary of the arguments, for display. */
    args: text('args'),
    /** Member the run acted for. */
    userId: text('user_id'),
    /** `blocked`: the member's role did not allow it. */
    status: text('status').$type<ActionStatus>().notNull(),
    ms: integer('ms').notNull().default(0),
    callerKind: text('caller_kind').$type<CallerKind>().notNull().default('user'),
    /** MCP client id for `agent`, source app slug for `app`. */
    callerId: text('caller_id'),
    callerName: text('caller_name'),
    consentId: uuid('consent_id').references(() => consents.id, { onDelete: 'set null' }),
    note: text('note'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    /** Per-node metrics when the run executed an agent graph; null for plain actions and tool calls. */
    nodes: jsonb('nodes').$type<RunNode[]>(),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [
    check('runs_env_check', sql`${t.env} in (${oneOf(ENV_NAMES)})`),
    check('runs_status_check', sql`${t.status} in (${oneOf(ACTION_STATUSES)})`),
    check('runs_caller_kind_check', sql`${t.callerKind} in (${oneOf(CALLER_KINDS)})`),
    index('runs_app_at_idx').on(t.app, t.at),
    index('runs_app_caller_at_idx').on(t.app, t.callerKind, t.at),
  ],
);

export const qaRuns = pgTable(
  'qa_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    app: text('app')
      .notNull()
      .references(() => apps.slug, { onDelete: 'cascade' }),
    env: text('env').$type<EnvName>().notNull(),
    versionId: uuid('version_id').references(() => versions.id, { onDelete: 'set null' }),
    /** `failed`: at least one check got the wrong answer. `error`: the run could not finish. */
    status: text('status').$type<QaStatus>().notNull(),
    checks: jsonb('checks').$type<QaCheckResult[]>().notNull().default([]),
    error: text('error'),
    startedBy: text('started_by').notNull(),
    startedAt: tstz('started_at').notNull(),
    finishedAt: tstz('finished_at').notNull(),
  },
  (t) => [
    check('qa_runs_env_check', sql`${t.env} in (${oneOf(ENV_NAMES)})`),
    check('qa_runs_status_check', sql`${t.status} in (${oneOf(QA_STATUSES)})`),
    index('qa_runs_app_started_idx').on(t.app, t.startedAt),
  ],
);

export type AppRow = typeof apps.$inferSelect;
export type EnvRow = typeof envs.$inferSelect;
export type VersionRow = typeof versions.$inferSelect;
export type MemberRow = typeof appMembers.$inferSelect;
export type GrantRow = typeof grants.$inferSelect;
export type ConsentRow = typeof consents.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;
export type TicketEventRow = typeof ticketEvents.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;
export type ImprovementRunRow = typeof improvementRuns.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type QaRunRow = typeof qaRuns.$inferSelect;
