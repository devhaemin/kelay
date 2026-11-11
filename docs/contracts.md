# Kelay service contracts

Every service and package builds against these contracts. The types and validators live in [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts). Token helpers live in [`packages/tokens`](../packages/tokens). Read [`infrastructure.md`](infrastructure.md) for why the system is shaped this way.

## 0. Repo conventions

- **Layout.** pnpm workspace: `packages/*` (libraries), `services/*` (deployables), `apps/*` (UIs), `examples/*`, `infra/*`.
- **Language and runtime.** TypeScript, ESM (`"type": "module"`), Node 22+. Imports use explicit `.ts` extensions.
- **Packages** export their TypeScript source (`"exports": { ".": "./src/index.ts" }`). Services bundle for production with `tsup`.
- **Each package's `package.json` defines:**
  - `typecheck`: `tsc -p tsconfig.json`, extending `../../tsconfig.base.json`;
  - `test`: `vitest run`;
  - for services, `dev` (via `tsx watch`) and `build`.
- **HTTP services** use Hono on `@hono/node-server`, and Zod (v4) for validation.
- **Tests that need Postgres** run against a disposable `postgres:17` container on the port listed in §11, and must clean it up.
- **Errors.** Every service answers failures with `{ error: { code, message } }`. `code` is an `ErrorCode` and the HTTP status is `HTTP_STATUS[code]`:

  | Code | Status | Meaning |
  |---|---|---|
  | `invalid_request` | 400 | The request is malformed or fails validation. |
  | `unauthenticated` | 401 | The user token is missing or invalid. |
  | `forbidden_caller` | 403 | The caller token is missing, invalid or for another app. |
  | `denied` | 403 | The user is known but may not do this. |
  | `unknown_app`, `unknown_collection` | 404 | The app or collection does not exist. |
  | `not_found` | 404 | Any other resource (ticket, version, proposal, route) does not exist. |
  | `conflict` | 409 | The request is valid but the resource is not in a state that allows it. |
  | `rate_limited` | 429 | A rate limit was reached. |
  | `internal` | 500 | The service failed. |

## 1. Identifiers

- App slugs match `^[a-z][a-z0-9-]{1,62}$`.
- Collection, field, role, action and node names match `^[a-z][a-z0-9_]{0,62}$`.
- Anything that becomes SQL is validated against these patterns and quoted. No user string is ever concatenated into SQL.

## 2. App schema (`AppSchema`)

An app declares its roles, collections and actions. See `fixtures/ticket-board/schema.json`.

- **Physical layout.** Each collection is a table `app.<name>` in the app's database.
- **Implicit columns:**

  ```sql
  id         uuid        primary key default gen_random_uuid()
  org_id     text        not null default kelay.org()
  owner_id   text        not null default kelay.uid()
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()
  shared     boolean     not null default false   -- only when the collection has "shared": true
  ```

- **Field types:** `text`→`text`, `number`→`double precision`, `boolean`→`boolean`, `timestamp`→`timestamptz`, `uuid`→`uuid`, `json`→`jsonb`, `ref`→`uuid references app.<ref>(id)`. `required` means `not null`.
- **`updated_at`** is set by a `BEFORE UPDATE` trigger on every collection table (`kelay.touch_updated_at()`), so it is correct whoever writes the row.
- **Schema changes.** The control API applies the migration from `@kelay/policy` (`migrationSql`) to an env's database on every deploy to it and on every publish. It can be re-run. A field added to the schema later becomes `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. A `required` field added this way is nullable in the database, because existing rows have no value for it. Columns of removed fields stay.
- **Ownership.** `ownerField` names the text column that decides "mine" for the `mine` and `mine_shared` scopes. It defaults to `owner_id`; for tickets the fixture uses `assignee_id`.
- **Actions** may name an agent graph (`graph`) that runs when the action is called.

## 3. Permissions → Postgres RLS (`PolicyMatrix`)

`role → collection → { read, create, update, delete } → scope`. A missing entry means `none`.

**Install order.** Every app database first runs [`packages/contracts/sql/kelay_auth.sql`](../packages/contracts/sql/kelay_auth.sql). It provides:
- `kelay.claims()`, `kelay.uid()`, `kelay.role()`, `kelay.org()`, `kelay.plan()`;
- `kelay.touch_updated_at()`, the trigger function behind `updated_at` (§2);
- the `app` schema;
- the `kelay_runtime` role (NOLOGIN, NOBYPASSRLS).

`migrationSql` then grants `kelay_runtime` to the role that runs the migration, when that role may not yet `SET ROLE` to it. Run the migration as the login role the Data API connects with: a managed database's admin user is not a superuser, and without the grant its `SET LOCAL ROLE kelay_runtime` fails.

**Scope semantics.** Every policy also requires `org_id = kelay.org()`.

| Scope | `USING` (read/update/delete) | `WITH CHECK` (create/update) |
|---|---|---|
| `all` | `true` | `true` |
| `mine` | `<ownerField> = kelay.uid()` | same as `USING` |
| `mine_shared` | `<ownerField> = kelay.uid() OR shared` (`mine` if the collection is not shared) | create: `true`; update: `<ownerField> = kelay.uid()` |
| `none` | no policy, so denied | no policy |

**Policy SQL rules.**
- One policy per role × collection × op, named `<collection>_<op>_<role>`.
- Each policy is restricted with `kelay.role() = '<role>'`.
- `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
- `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO kelay_runtime`.

**Per-transaction setup** (the Data API is the only writer of claims):

```sql
BEGIN;
SELECT set_config('request.jwt.claims', $1, true);   -- verified claims JSON
SET LOCAL ROLE kelay_runtime;
-- query
COMMIT;
```

## 4. Tokens

**User tokens** are issued by Kelay ID, signed EdDSA (Ed25519), and verified against `KELAY_ID_JWKS_URL`.
- Claims (`KelayClaims`): `iss`, `sub`, `aud`, `exp`, `iat`, `app`, `org`, `role`, `plan`, and optional `azp`.
- `azp` is the MCP client id, which is a CIMD URL.
- Screen and SDK tokens use `aud = kelay:app:<app>`. MCP tokens use `aud = <MCP resource URL>` (§7).

**Caller tokens** identify the calling component.
- They are HS256 JWTs signed with `KELAY_CALLER_SECRET` and carried in the `x-kelay-caller` header.
- Claims (`CallerClaims`): `{ kind: 'app-runtime', app, env }` or `{ kind: 'service', svc }`.
- Platform services accept app-runtime callers only for their own `app`.
- Use `@kelay/tokens`: `verifyKelayToken`, `signCallerToken`, `verifyCallerToken`. `createDevSigner` is for tests and local runs.
- The control API mints an app's `app-runtime` caller token when it deploys a version (`POST /v1/apps/:app/envs/:env/deploy`). The version stores only a reference to it (`callerTokenRef`). The `local` deploy driver returns the token itself in the deploy response; the `aws` driver puts it in the functions' environment.

**Behind the router.** The router signs requests to a Lambda function URL with SigV4, and the signature takes over `authorization`. On those requests the router moves the caller's own `authorization` (the user token) to **`x-kelay-authorization`** (`USER_AUTHORIZATION_HEADER`). It drops every inbound `x-kelay-*` header first, so an app can trust the ones it receives. App server code reads the user token with `userTokenFromHeaders` or `requireUserToken` from `@kelay/sdk/server`, which check `x-kelay-authorization` first and `authorization` second.

## 5. Data API — `POST /v1/apps/:app/query`

- **Headers:**
  - `authorization: Bearer <user token>`: required, and the `app` claim must equal `:app`;
  - `x-kelay-caller: <caller token>`: required.
- **Body:** `QueryRequest`, with ops `select | insert | update | delete`. `where` is equality by default, or `{eq, ne, in, gt, gte, lt, lte, like}`.
- **Validation.** Collection and field names are checked against the app's `AppSchema`. Reserved columns are readable and filterable. Clients may never write `id`, `org_id`, `created_at` or `updated_at`. `owner_id` is set by its default.
- **200 response:** `{ rows, count }`. Insert, update and delete use `RETURNING *`.
- **Errors:** `{ error: { code, message } }` with `ErrorCode` → `HTTP_STATUS`.
  - An RLS `WITH CHECK` failure (SQLSTATE 42501) maps to `denied`.
  - An update or delete that changes 0 rows while a select with the same `where` sees ≥ 1 row also maps to `denied`. This is how a screen learns "you can't move that ticket" instead of silently doing nothing.
- **App lookup.** Apps resolve through the registry (§6). In the MVP that is `KELAY_APPS_FILE`, loaded with `loadAppRegistry` from `@kelay/contracts/registry`.

### Feedback — `POST /v1/apps/:app/feedback` (control API)

Same two headers as the Data API. Body `{ text, route?, context? }`. The `201` response is `{ ticketId }`, where `ticketId` is the ticket's **key** (`FB-131`), numbered per app. It is the key builders see on the Feedback board and the one proposals cite in `refs`; the ticket's UUID never leaves the control API through this route.

## 6. App registry (MVP)

`fixtures/apps.local.json` maps an app slug to its handle, `databaseUrl`, schema and policy (inline or by file).

The control API serves the same `AppRegistryEntry` to service callers at `GET /internal/v1/apps/:app?env=dev|prod`. `env` defaults to `prod`. The entry comes from that environment's active version and database; an environment with no deployed schema or no database answers `unknown_app`.

## 7. MCP · A2A gateway

- **Endpoint.** One MCP server per app at `POST {MCP_PUBLIC_BASE_URL}/:handle/:app/mcp` (Streamable HTTP). The resource URL is exactly that URL.
- **Unauthenticated calls** get `401` with `WWW-Authenticate: Bearer resource_metadata="{MCP_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/:handle/:app/mcp"`. That metadata document (RFC 9728) lists Kelay ID as the authorization server.
- **Tokens.** Verify `aud = resource URL`, `app` and `azp`.
- **Scopes.** Kelay ID grants MCP clients one scope, `offline_access` (`MCP_SCOPES`), which allows refresh tokens. `openid`, `profile` and `email` are not offered: with `openid` the token's `aud` would also name the userinfo endpoint, and an MCP token must carry exactly the app's resource URL. What a client may do is decided by the user's role through RLS, not by scopes. The protected resource metadata and the agent card advertise the same list.
- **Tools generated from `AppSchema`:**
  - `<collection>_list` (where, limit), `<collection>_get` (id), `<collection>_create`, `<collection>_update` (id + values), `<collection>_delete` (id);
  - `action_<name>` for each action.
  - Every tool calls the Data API with the user's token, so RLS applies.
- **Limits.** Two token buckets, each set by `MCP_RATE_PER_MIN` (default 60): one per `sub × app` and one per `azp × app`. A request takes a token from both. The client bucket is per app so that one busy app cannot use up an assistant's budget for every other app.
- **Metering.** One `McpCallRecord` per tool call, written as a JSON log line: `{type:"mcp_call", app, sub, client, tool, ms, ok, denied?, args?}`. `denied` is set when the user's role refused the call; `args` is the arguments as JSON, cut to 200 characters. When `CONTROL_API_URL` is set, the gateway also posts the records to `POST {CONTROL_API_URL}/internal/v1/mcp-calls` as `{ calls: McpCallRecord[] }` (at most 500 per request, each stamped with `at`). It sends them in batches in the background, so a slow control API never delays a tool call.
- **A2A.** The gateway serves an A2A agent card at `/:handle/:app/.well-known/agent-card.json`. Its OAuth security scheme points at Kelay ID's real endpoints (§8).

## 8. Kelay ID

- **Stack.** better-auth with Postgres (control DB), using these plugins:
  - `jwt`, with JWKS at `/api/auth/jwks` and issuer `KELAY_ID_ISSUER`;
  - `mcp` and `cimd`, for MCP OAuth 2.1 and the Client ID Metadata Document flow (MCP 2026-07-28; DCR off).
  - Social sign-in: Google, Kakao, GitHub, and email/password in dev.
- **OAuth endpoints.** better-auth is mounted at `/api/auth`, so the endpoints are `{KELAY_ID_ISSUER}/api/auth/oauth2/authorize` and `{KELAY_ID_ISSUER}/api/auth/oauth2/token`. The RFC 8414 metadata is at `{KELAY_ID_ISSUER}/.well-known/oauth-authorization-server`.
- **App-scoped token.** `POST /v1/token { app }` with a session returns `{ token }`. Its claims come from `app_members` (contract §9 below) and it uses `aud = kelay:app:<app>`.
- **MCP tokens** are bound to the app's MCP resource URL and carry the same claims plus `azp`. Consent is per user × app × client.

## 9. Control DB tables shared across services

The control API owns the migrations. Other services read only:

- `app_members(app text, user_id text, org text, role text, plan text, status text, primary key (app, user_id))`

In the other direction, the control API reads Kelay ID's `user`, `account` and `session` tables (better-auth's, in the same database) to show a member's name, email, sign-in provider and last sign-in. It never writes them.

**Member writes go through the control API**, so the table has one writer:

- `PUT /internal/v1/apps/:app/members/:userId { org, role?, plan?, status? }` (service caller). Kelay ID calls it when a person first opens an app. It creates the member or updates it; `role` defaults to `member` when the app declares it, and a banned member stays banned.
- `PATCH /v1/apps/:app/members/:userId` and `DELETE /v1/apps/:app/members/:userId` (builder token) change a role or plan, ban, unban or remove a member.

**Runs.** The control API also owns `runs`, the record of what was done in each app; Monitoring reads it. Services write to it through the control API (service caller), never directly:

- `POST /internal/v1/runs { runs: [{ app, action, status: "ok" | "blocked" | "error", env?, userId?, args?, ms?, note?, costUsd?, at?, caller?: { kind: "user" | "agent" | "app", id?, name? } }] }`, 1 to 500 per request;
- `POST /internal/v1/mcp-calls { calls: McpCallRecord[] }` from the MCP gateway (§7). Each call becomes a run whose caller is the member's assistant.

Both answer `201 { recorded, skipped }`; records for apps that do not exist are skipped. The builder routes over this data are listed in [`services/control-api/README.md`](../services/control-api/README.md).

## 10. Agent graph (`GraphSpec`)

- **Nodes.** A node lists `next` (one node, or several that run in parallel and share one join node), plus optional `retry`, `timeoutSeconds`, `model` and `review`. Edges through `next` may not form a cycle; the only way back is a review.
- **Parallel.** Branch nodes each point to the same join node, and the join receives their outputs as an array in `next` order. A branch cannot have a review. If one branch fails, the run fails.
- **Retry.** `retry.maxAttempts` counts **retries after the first try**: `2` means up to three invocations. `intervalSeconds` is a whole number of seconds before the first retry (default 1), multiplied by `backoffRate` (default 2) for each later one. `NodeInvocation.attempt` is 1 on the first try. Lambda service errors are always retried, whatever the node says.
- **Review.** A node with `review` must output an object with `approved: boolean`; anything else fails the run with `Kelay.InvalidReviewOutput`. When `approved` is false and this review has rejected fewer than `maxLoops` times, the run goes back to `onReject` with the review's output as its input. Once `maxLoops` rejections are used up, the run continues to `next` as if approved (or ends with the review output). `NodeInvocation.loop` is the number of rejections so far in the run, across all reviews, starting at 0.
- **Execution input** (`GraphExecutionInput`): `{ input, userToken }`. `input` becomes the start node's input (`null` when absent). `userToken` is the user's Kelay ID token; every node receives it and calls the Data API as that user.
- **Execution.** `@kelay/graph` compiles the spec to Step Functions ASL. Node tasks invoke the app's node Lambda with a `NodeInvocation` payload. It also runs the same spec locally for tests and dev.
- **Deploying a graph.** Compile with `functionArn: '${NodeFunctionArn}'` (`NODE_FUNCTION_ARN_PLACEHOLDER`) and send the ASL as `graphs[].definition` to the control API's deploy route. The deploy driver replaces the placeholder with the node function's alias ARN for that environment.

## 11. Local ports

| Service | Port |
|---|---|
| LLM gateway (LiteLLM) | 4000 |
| Kelay ID | 4001 |
| Data API | 4002 |
| Control API | 4003 |
| MCP gateway | 4004 |
| Dev sign-in helper (`pnpm dev:up`) | 4005 |
| Builder | 4006 |
| Router (wrangler dev) | 8787 |
| Postgres (compose) | 54320 |

Postgres ports for parallel test containers: policy and SDK 54331, data-api 54332, identity 54333, control-api 54334, mcp-gateway 54335, e2e 54336.

## 12. Models

- All model calls go through the LLM gateway. They use the official Anthropic SDK (`@anthropic-ai/sdk`) with `baseURL = LLM_GATEWAY_URL` and the gateway key.
- The default model is `claude-opus-5-5`; override it with env vars.
- No consumer subscription logins anywhere.
