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

/**
 * Where the router puts the caller's own `authorization` (the user token) on requests it signs with
 * SigV4 for a Lambda function URL, since the signature occupies `authorization` there.
 */
export const USER_AUTHORIZATION_HEADER = 'x-kelay-authorization';

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
  'not_found',
  'conflict',
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
  not_found: 404,
  conflict: 409,
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

// ---------------------------------------------------------------- §7 MCP · A2A gateway

/**
 * Scopes MCP clients may request from Kelay ID. `openid` is left out on purpose: with it the token's
 * `aud` would also name the userinfo endpoint, and MCP tokens carry exactly the app's resource URL.
 */
export const MCP_SCOPES = ['offline_access'] as const;

/** One metered tool call. The gateway logs it and, when CONTROL_API_URL is set, posts it to the control API. */
export const McpCallRecord = z.object({
  type: z.literal('mcp_call'),
  app: AppSlug,
  sub: z.string().min(1),
  /** The MCP client id (`azp`). */
  client: z.string().min(1),
  tool: z.string().min(1).max(200),
  ms: z.number().int().min(0),
  ok: z.boolean(),
  /** Set when the call failed because the user's role may not do it. */
  denied: z.boolean().optional(),
  /** The call's arguments as compact JSON, cut to 200 characters. */
  args: z.string().max(200).optional(),
  /** ISO-8601 time of the call; the receiver uses its own clock when absent. */
  at: z.iso.datetime().optional(),
});
export type McpCallRecord = z.infer<typeof McpCallRecord>;

// ---------------------------------------------------------------- §10 agent graph

export const GraphNode = z.object({
  /** Next node, or two or more nodes that run in parallel and must share one `next` (the join). */
  next: z.union([Ident, z.array(Ident).min(2)]).optional(),
  model: z.string().optional(),
  timeoutSeconds: z.number().int().positive().max(900).optional(),
  retry: z
    .object({
      /** Retries after the first try (ASL `MaxAttempts`): 2 means up to 3 invocations. */
      maxAttempts: z.number().int().min(0).max(10),
      /** Whole seconds before the first retry (ASL `IntervalSeconds`); defaults to 1. */
      intervalSeconds: z.number().int().positive().optional(),
      backoffRate: z.number().min(1).optional(),
    })
    .optional(),
  /**
   * Output must be an object with `approved: boolean`. Not approved → back to `onReject` with that output as
   * its input, at most `maxLoops` times for this review; after that the run continues as if approved.
   */
  review: z.object({ onReject: Ident, maxLoops: z.number().int().min(1).max(5) }).optional(),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphSpec = z.object({ name: AppSlug, start: Ident, nodes: z.record(Ident, GraphNode) });
export type GraphSpec = z.infer<typeof GraphSpec>;

/** Input of a graph execution (Step Functions `StartExecution` input, or `runLocal` options). */
export interface GraphExecutionInput {
  input?: unknown;
  /** The user's Kelay ID token, handed to every node invocation. */
  userToken: string;
}

/**
 * Placeholder for the node function's alias ARN in compiled ASL handed to the control API
 * (`POST /v1/apps/:app/envs/:env/deploy`, `graphs[].definition`); the deploy driver substitutes it.
 */
export const NODE_FUNCTION_ARN_PLACEHOLDER = '${NodeFunctionArn}';

/** Payload every agent node function receives. */
export interface NodeInvocation {
  runId: string;
  app: string;
  env: 'dev' | 'prod';
  graph: string;
  node: string;
  /** 1 on the first try, then 2, 3, … on retries. */
  attempt: number;
  /** Review rejections so far in this run, across all review nodes; 0 until the first one. */
  loop: number;
  input: unknown;
  /** The user's Kelay ID token: nodes call the Data API as that user. */
  userToken: string;
}

// ---------------------------------------------------------------- §9 control DB shared tables

/** Columns of `app_members` in the control DB. Only control-api writes it; identity reads it. */
export interface AppMemberRow {
  app: string;
  user_id: string;
  org: string;
  role: string;
  plan: string;
  status: 'active' | 'unconfirmed' | 'banned';
}

// ---------------------------------------------------------------- §11 local ports

export const LOCAL_PORTS = {
  llmGateway: 4000,
  identity: 4001,
  dataApi: 4002,
  controlApi: 4003,
  mcpGateway: 4004,
  builder: 4006,
  router: 8787,
  postgres: 54320,
} as const;

