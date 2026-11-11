// Shared contracts for every Kelay service. docs/contracts.md explains each section.
// Changing a shape here is a cross-service change: update the doc and every consumer together.
import { z } from 'zod';

// ---------------------------------------------------------------- §1 identifiers

export const SLUG = /^[a-z][a-z0-9-]{1,62}$/;
export const IDENT = /^[a-z][a-z0-9_]{0,62}$/;

export const AppSlug = z.string().regex(SLUG);
export const Ident = z.string().regex(IDENT);

// ---------------------------------------------------------------- §2 app schema

export const FieldType = z.enum(['text', 'number', 'boolean', 'timestamp', 'uuid', 'json', 'ref']);
export type FieldType = z.infer<typeof FieldType>;

export const FieldDef = z.object({
  type: FieldType,
  required: z.boolean().optional(),
  /** Target collection when type is `ref`. */
  ref: Ident.optional(),
  description: z.string().optional(),
});
export type FieldDef = z.infer<typeof FieldDef>;

/** Columns every collection table gets. Fields may not reuse these names. */
export const RESERVED_COLUMNS = ['id', 'org_id', 'owner_id', 'created_at', 'updated_at', 'shared'] as const;

export const CollectionDef = z.object({
  name: Ident,
  label: z.string().optional(),
  fields: z.record(Ident, FieldDef),
  /** Adds a boolean `shared` column; scope `mine_shared` also matches rows where shared = true. */
  shared: z.boolean().optional(),
  /** Text column that decides "mine" for scopes `mine` / `mine_shared`. Defaults to `owner_id`. */
  ownerField: Ident.optional(),
});
export type CollectionDef = z.infer<typeof CollectionDef>;

export const ActionDef = z.object({
  name: Ident,
  description: z.string(),
  input: z.record(Ident, FieldDef),
  /** Agent graph this action runs, by GraphSpec.name. */
  graph: AppSlug.optional(),
});
export type ActionDef = z.infer<typeof ActionDef>;

export const AppSchema = z.object({
  app: AppSlug,
  roles: z.array(Ident).min(1),
  collections: z.array(CollectionDef).min(1),
  actions: z.array(ActionDef).optional(),
});
export type AppSchema = z.infer<typeof AppSchema>;

// ---------------------------------------------------------------- §3 permission policy

export const Scope = z.enum(['all', 'mine_shared', 'mine', 'none']);
export type Scope = z.infer<typeof Scope>;
export const Op = z.enum(['read', 'create', 'update', 'delete']);
export type Op = z.infer<typeof Op>;

export const OpScopes = z.object({ read: Scope, create: Scope, update: Scope, delete: Scope });
export type OpScopes = z.infer<typeof OpScopes>;

/** role → collection → op → scope. A missing role or collection means every op is `none`. */
export const PolicyMatrix = z.record(Ident, z.record(Ident, OpScopes));
export type PolicyMatrix = z.infer<typeof PolicyMatrix>;

/** Postgres role every runtime transaction runs as (NOLOGIN, NOBYPASSRLS). */
export const RUNTIME_DB_ROLE = 'kelay_runtime';
/** Schema holding collection tables in each app database. */
export const APP_DB_SCHEMA = 'app';

// ---------------------------------------------------------------- §4 tokens

export interface KelayClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  /** App slug the token is scoped to. */
  app: string;
  org: string;
  role: string;
  plan: string;
  /** MCP client id (CIMD URL) when the token was issued to an external assistant. */
  azp?: string;
}

export const audienceForApp = (app: string): string => `kelay:app:${app}`;

/** HS256 token that identifies the calling component to platform services. */
export interface CallerClaims {
  kind: 'app-runtime' | 'service';
  app?: string;
  env?: 'dev' | 'prod';
  svc?: string;
}

export const CALLER_HEADER = 'x-kelay-caller';

// ---------------------------------------------------------------- §5 Data API

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof Scalar>;

export const Condition = z.union([
  Scalar,
  z
    .object({
      eq: Scalar,
      ne: Scalar,
      in: z.array(Scalar).max(500),
      gt: Scalar,
      gte: Scalar,
      lt: Scalar,
      lte: Scalar,
      like: z.string(),
    })
    .partial()
    .refine((o) => Object.keys(o).length > 0, 'empty condition'),
]);
export const Where = z.record(Ident, Condition);
export type Where = z.infer<typeof Where>;

export const OrderBy = z.array(z.object({ field: Ident, dir: z.enum(['asc', 'desc']).optional() })).max(5);

export const QueryRequest = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('select'),
    collection: Ident,
    where: Where.optional(),
    orderBy: OrderBy.optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  z.object({
    op: z.literal('insert'),
    collection: Ident,
    values: z.union([z.record(Ident, z.unknown()), z.array(z.record(Ident, z.unknown())).min(1).max(500)]),
  }),
  z.object({ op: z.literal('update'), collection: Ident, where: Where, values: z.record(Ident, z.unknown()) }),
  z.object({ op: z.literal('delete'), collection: Ident, where: Where }),
]);
export type QueryRequest = z.infer<typeof QueryRequest>;

export interface QueryResponse {
  rows: Record<string, unknown>[];
  count: number;
}

export const ErrorCode = z.enum([
  'invalid_request',
  'unauthenticated',
  'forbidden_caller',
  'denied',
  'unknown_app',
  'unknown_collection',
  'rate_limited',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export interface ErrorResponse {
  error: { code: ErrorCode; message: string };
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden_caller: 403,
  denied: 403,
  unknown_app: 404,
  unknown_collection: 404,
  rate_limited: 429,
  internal: 500,
};

// ---------------------------------------------------------------- §6 app registry (MVP file)

export const AppRegistryEntry = z.object({
  handle: AppSlug,
  databaseUrl: z.string(),
  schema: AppSchema,
  policy: PolicyMatrix.optional(),
});
export const AppRegistry = z.object({ apps: z.record(AppSlug, AppRegistryEntry) });
export type AppRegistry = z.infer<typeof AppRegistry>;
export type AppRegistryEntry = z.infer<typeof AppRegistryEntry>;

// ---------------------------------------------------------------- §7 agent graph

export const GraphNode = z.object({
  /** Next node, or two or more nodes that run in parallel and must share one `next` (the join). */
  next: z.union([Ident, z.array(Ident).min(2)]).optional(),
  model: z.string().optional(),
  timeoutSeconds: z.number().int().positive().max(900).optional(),
  retry: z
    .object({
      maxAttempts: z.number().int().min(0).max(10),
      intervalSeconds: z.number().positive().optional(),
      backoffRate: z.number().min(1).optional(),
    })
    .optional(),
  /** Output must contain `approved: boolean`. Not approved → back to `onReject`, at most `maxLoops` times. */
  review: z.object({ onReject: Ident, maxLoops: z.number().int().min(1).max(5) }).optional(),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphSpec = z.object({ name: AppSlug, start: Ident, nodes: z.record(Ident, GraphNode) });
export type GraphSpec = z.infer<typeof GraphSpec>;

/** Payload every agent node function receives. */
export interface NodeInvocation {
  runId: string;
  app: string;
  env: 'dev' | 'prod';
  graph: string;
  node: string;
  attempt: number;
  loop: number;
  input: unknown;
  /** The user's Kelay ID token: nodes call the Data API as that user. */
  userToken: string;
}

// ---------------------------------------------------------------- §8 control DB shared tables

/** Columns of `app_members` in the control DB (owned by control-api; read by identity). */
export interface AppMemberRow {
  app: string;
  user_id: string;
  org: string;
  role: string;
  plan: string;
  status: 'active' | 'unconfirmed' | 'banned';
}

// ---------------------------------------------------------------- §9 local ports

export const LOCAL_PORTS = {
  llmGateway: 4000,
  identity: 4001,
  dataApi: 4002,
  controlApi: 4003,
  mcpGateway: 4004,
  router: 8787,
  postgres: 54320,
} as const;

