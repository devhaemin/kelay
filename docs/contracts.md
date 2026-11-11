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

**Database logins.** A database URL may leave out the user and the password. A service then logs in with `DB_USER` and `DB_PASSWORD` from its environment (`databaseUrlWithCredentials` in `@kelay/contracts`); a URL that names a user is used as it is. Deployed environments store URLs without a login, so the URLs in the registry (§6) hold no secret, and the control API and the Data API share one login, which is what makes the grant above work. The control API creates an env's database the first time a version is deployed to it, so that login needs `CREATEDB` and `CREATEROLE`.

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

**In a dev preview** there is no router. The starter template's `/api/kelay` route then reads the person from their Kelay ID session: the browser sends Kelay ID's session cookie to the preview as well, because the two share a site (locally both are `localhost`, and cookies ignore the port). The route forwards that cookie to `POST {KELAY_ID_ISSUER}/v1/token { app }` (§8), keeps the token until shortly before it expires, and calls the Data API with it and with the app-runtime caller token of the dev deploy. Without a session it answers `unauthenticated`, and `GET /api/kelay/signin` sends the browser to Kelay ID's login page and back. A person who is signed in but is not a member of the app gets Kelay ID's `denied`.

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
- **App lookup.** Apps resolve through the registry (§6). An `app-runtime` caller reaches the database of the env in its caller token (`dev` or `prod`); a `service` caller reaches production. When the registry cannot be reached and has no earlier answer, the request fails with `internal`, never with `unknown_app`.

### Feedback — `POST /v1/apps/:app/feedback` (control API)

Same two headers as the Data API. Body `{ text, route?, context? }`. The `201` response is `{ ticketId }`, where `ticketId` is the ticket's **key** (`FB-131`), numbered per app. It is the key builders see on the Feedback board and the one proposals cite in `refs`; the ticket's UUID never leaves the control API through this route.

## 6. App registry

Kelay ID, the Data API and the MCP gateway look apps up through an `AppRegistrySource` from `@kelay/contracts/registry`. `registrySourceFromEnv` picks it from the service's environment:

| `KELAY_APPS_SOURCE` | Reads | Used |
|---|---|---|
| `file` (default) | `KELAY_APPS_FILE`, once at start. `fixtures/apps.local.json` maps an app slug to its handle, `databaseUrl`, schema and policy (inline or by file). The file has one entry per app, so it answers the same for `dev` and `prod`. | A service run on its own, and unit tests. It knows no app that was built later. |
| `control-api` | The control API at `CONTROL_API_URL`, as a `service` caller (§4). | Every deployed environment, `pnpm dev:up` and the e2e suite. |

`pnpm dev:up` sets `KELAY_APPS_SOURCE=control-api` with `KELAY_APPS_TTL_SECONDS=5`, so an app the Builder deployed to Development is known to the Data API at once and a changed schema within five seconds. The migration and the seed still read Ticket Board's schema and database from `KELAY_APPS_FILE`.

The control API serves the registry to service callers:

- `GET /internal/v1/apps/:app?env=dev|prod` → the app's `AppRegistryEntry`. `env` defaults to `prod`. The entry comes from that environment's active version and database; an environment with no deployed schema or no database answers `unknown_app`.
- `GET /internal/v1/apps?env=dev|prod` → `{ apps: [{ app, handle }] }` (`AppList`): the apps the first route would answer for, without their database URLs.

The `control-api` source caches each answer, "no such app" included, for `KELAY_APPS_TTL_SECONDS` (default 30). A newly published app, a new schema or a moved database is therefore seen within that time. When the control API does not answer, the source keeps serving the last answer it has; with none, the lookup fails.

Who asks for what:

- **Data API:** the entry of the app being queried, in the caller's env (§5).
- **MCP gateway:** the production entry of the app in the request path. It builds the app's tools from that entry and rebuilds them when the entry changes.
- **Kelay ID:** the production list, every `KELAY_APPS_TTL_SECONDS`. It needs only slugs and handles, to know which MCP resources exist. Kelay ID starts with an empty list, so people can sign in before the first app is published.

### Route table

The Router Worker finds where `/<handle>/<app>` is served in Workers KV: the key is `routeKey(handle, app)` = `app:<handle>/<app>`, the value an `AppRoute` (`@kelay/contracts`):

```jsonc
{ "prod": { "origin": "https://<id>.lambda-url.ap-northeast-2.on.aws", "region": "ap-northeast-2" },
  "dev":  { "origin": "https://<id>.lambda-url.ap-northeast-2.on.aws", "region": "ap-northeast-2" } }
```

- An env the app is not deployed to has no target; the Router answers `unknown_app` for it. `dev` is served on the `dev.` host of the app domain.
- The control API writes the entry through a `RouteStore` after every deploy and publish, from the function URL of each env's active version, and deletes it when the app is archived. `ROUTE_STORE` picks the store: `memory` (default), `file` (`ROUTES_FILE`) or `cloudflare-kv` (`CLOUDFLARE_ACCOUNT_ID`, `ROUTES_KV_NAMESPACE_ID`, `CLOUDFLARE_API_TOKEN`).
- A deploy whose route could not be written still succeeds. Its answer carries `route: { key, published: false, error }`, and the next deploy or publish writes the whole entry again.

## 7. MCP · A2A gateway

- **Endpoint.** One MCP server per app at `POST {MCP_PUBLIC_BASE_URL}/:handle/:app/mcp` (Streamable HTTP). The resource URL is exactly that URL.
- **Unauthenticated calls** get `401` with `WWW-Authenticate: Bearer resource_metadata="{MCP_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/:handle/:app/mcp"`. That metadata document (RFC 9728) lists Kelay ID as the authorization server.
- **Tokens.** Verify `aud = resource URL`, `app` and `azp`.
- **Scopes.** Kelay ID grants MCP clients one scope, `offline_access` (`MCP_SCOPES`), which allows refresh tokens. `openid`, `profile` and `email` are not offered: with `openid` the token's `aud` would also name the userinfo endpoint, and an MCP token must carry exactly the app's resource URL. What a client may do is decided by the user's role through RLS, not by scopes. The protected resource metadata and the agent card advertise the same list.
- **Tools generated from `AppSchema`:**
  - `<collection>_list` (where, limit), `<collection>_get` (id), `<collection>_create`, `<collection>_update` (id + values), `<collection>_delete` (id);
  - `action_<name>` for each action.
  - Every collection tool calls the Data API with the user's token, so RLS applies.
  - An action tool starts the action's agent graph through the run orchestrator (§13) with the same token and `caller: { kind: "agent", id: <azp> }`, waits up to `MCP_ACTION_WAIT_MS` (default 45 seconds) and returns the run's output. A failed run, a run still going after the wait, and the per-user run cap come back as tool errors the assistant can read. Without `RUNNER_URL` an action tool answers "not available yet".
- **Limits.** Two token buckets, each set by `MCP_RATE_PER_MIN` (default 60): one per `sub × app` and one per `azp × app`. A request takes a token from both. The client bucket is per app so that one busy app cannot use up an assistant's budget for every other app.
- **Metering.** One `McpCallRecord` per tool call, written as a JSON log line: `{type:"mcp_call", app, sub, client, tool, ms, ok, denied?, args?}`. `denied` is set when the user's role refused the call; `args` is the arguments as JSON, cut to 200 characters. When `CONTROL_API_URL` is set, the gateway also posts the records to `POST {CONTROL_API_URL}/internal/v1/mcp-calls` as `{ calls: McpCallRecord[] }` (at most 500 per request, each stamped with `at`). It sends them in batches in the background, so a slow control API never delays a tool call.
- **A2A.** The gateway serves an A2A agent card at `/:handle/:app/.well-known/agent-card.json`. Its OAuth security scheme points at Kelay ID's real endpoints (§8). The card's JSON-RPC interface, `POST /:handle/:app/a2a`, implements `SendMessage` of A2A 1.0:
  - **Callers.** Without `x-kelay-caller` the caller is a member's own agent: the bearer token is the resource-bound token of an MCP client (`aud` = the MCP resource URL, with `azp`). With an `app-runtime` caller token of another app, the caller is that app acting for the user: the bearer token is the user's token for the target app, and the control API must report a `connected` A2A grant from the calling app (`GET /internal/v1/grants`). No such grant answers `403 denied`; a grant that cannot be checked answers `500`. Each call over a grant is counted with `POST /internal/v1/grants/calls`.
  - **Message → action.** A data part `{ action, input? }` names the action (by name or by its skill id `action_<name>`); else `metadata.skillId` does; else the app's default action runs: its first one with an agent graph. A data part without `action` is the input. The input is validated like the action tool's arguments.
  - **Answer.** The run's output comes back as a direct agent `Message`: `result.message` with `role: "ROLE_AGENT"`, one data part (or a text part for a string output) and `metadata: { action, runId }`. The gateway keeps no tasks and does not stream, so every other operation is `UnsupportedOperationError` (-32004). A failed run is a JSON-RPC error -32603 whose `data` names the reason.
  - **Versions.** `A2A-Version` may be `1.0` or `0.3`; anything else is `VersionNotSupportedError` (-32009). The 0.3 method name `message/send` is accepted and answered in the 0.3 shape.
  - The same two rate-limit buckets apply. The runner records the run with `caller.kind` `agent` or `app`.

## 8. Kelay ID

- **Stack.** better-auth with Postgres (control DB), using these plugins:
  - `jwt`, with JWKS at `/api/auth/jwks` and issuer `KELAY_ID_ISSUER`;
  - `mcp` and `cimd`, for MCP OAuth 2.1 and the Client ID Metadata Document flow (MCP 2026-07-28; DCR off).
  - Social sign-in: Google, Kakao, GitHub, and email/password in dev.
- **OAuth endpoints.** better-auth is mounted at `/api/auth`, so the endpoints are `{KELAY_ID_ISSUER}/api/auth/oauth2/authorize` and `{KELAY_ID_ISSUER}/api/auth/oauth2/token`. The RFC 8414 metadata is at `{KELAY_ID_ISSUER}/.well-known/oauth-authorization-server`.
- **Returning from sign-in.** `GET /login?return_to=<url>` sends the browser to `<url>` once the person is signed in, at once when they already are. The URL's origin must be Kelay ID's own or one of `KELAY_ID_CORS_ORIGINS`; outside a production build any loopback origin is accepted too, because dev previews listen on a free port. Any other value is dropped and the person stays on Kelay ID.
- **App-scoped token.** `POST /v1/token { app }` with a session returns `{ token }`. Its claims come from `app_members` (contract §9 below) and it uses `aud = kelay:app:<app>`. Only an `active` member gets one. The route does not consult the registry, so it also serves apps that are not published, such as the console (`kelay-console`). Browser calls are accepted from Kelay ID's own origin and from the origins in `KELAY_ID_CORS_ORIGINS`.
- **MCP tokens** are bound to the app's MCP resource URL and carry the same claims plus `azp`. Consent is per user × app × client. They exist only for apps in the registry (§6): better-auth takes its protected resources when an instance is created, so Kelay ID builds a new instance when the app list changes. Sessions, keys, clients and consents live in the control DB and carry over.
- **Consents.** When a person allows an assistant, Kelay ID records it in the control API (`PUT /internal/v1/consents`) before it grants anything; a consent the control API did not store is not granted. A production build requires `CONTROL_API_URL` and `KELAY_CALLER_SECRET` for this. Kelay ID looks its own consent row up on every token grant, which is how a revoke in the control API (§9) ends access.
- **The console's sign-in.** The console (`apps/console`) has no login form. It sends the browser to `/login?return_to={CONSOLE_URL}/auth/callback`. Back at the console, the browser's request carries Kelay ID's session cookie, and the console's server forwards it to `POST /v1/token { app: "kelay-console" }`. It keeps the token in the httpOnly cookie `kelay_token` and repeats the exchange when the token has less than three minutes left. Signing out calls better-auth's `POST /api/auth/sign-out` with the session cookie and `Origin: {CONSOLE_URL}`; the origins in `KELAY_ID_CORS_ORIGINS` are better-auth's trusted origins. All of this needs the browser to send the session cookie to both hosts: on `localhost` it does, and for two hosts under one domain set `KELAY_ID_COOKIE_DOMAIN` to that domain.
- **Becoming a builder.** A builder is an `active` member of `kelay-console` with the role `builder` or `admin`. With `KELAY_BUILDER_ALLOWLIST` (comma-separated emails) or `KELAY_OPEN_SIGNUP=true`, Kelay ID makes a person a builder when they sign up: it calls `PUT /internal/v1/apps/kelay-console/members/:userId { org: <user id>, role: "builder" }` (§9) after the account is created, and at their first `kelay-console` token request if they have no membership by then. Both need `CONTROL_API_URL` and `KELAY_CALLER_SECRET`. In a production build an allowlisted email must be verified, which only a social provider does. A person who is already a member, banned ones included, is never changed by this.
- **Sign-in methods.** A provider is on when both `<PROVIDER>_CLIENT_ID` and `<PROVIDER>_CLIENT_SECRET` are set. Email and password is on in dev, and in a production build only with `KELAY_ID_EMAIL_PASSWORD=true`.

## 9. Control DB tables shared across services

The control API owns the migrations. Other services read only:

- `app_members(app text, user_id text, org text, role text, plan text, status text, primary key (app, user_id))`

In the other direction, the control API reads Kelay ID's `user`, `account` and `session` tables (better-auth's, in the same database) to show a member's name, email, sign-in provider and last sign-in. It never writes them.

**Consents.** The control API owns `consents`: which assistant a person connected to which app. Kelay ID writes it only through `PUT /internal/v1/consents { userId, app, clientId, clientName?, scopes }` (service caller), and `GET /internal/v1/consents/check` answers whether a consent is active. Revoking happens in the control API alone (`POST /v1/apps/:app/consents/:id/revoke` for the builder, `POST /v1/me/consents/:id/revoke` for the person). In the same transaction the control API deletes what Kelay ID keeps for that user, app and client: the rows of better-auth's `oauthConsent` and `oauthRefreshToken` tables. These two are the only Kelay ID tables the control API writes, and deleting is all it does to them. Kelay ID's own consent-delete route is off, so the two records cannot drift apart.

**Member writes go through the control API**, so the table has one writer:

- `PUT /internal/v1/apps/:app/members/:userId { org, role?, plan?, status? }` (service caller). It creates the member or updates it; `role` defaults to `member` when the app declares it, and a banned member stays banned. The Builder calls it once per app, after the first deploy to Development, to make the builder a member with the role `admin` (the app's first role when it declares no `admin`) in the org of their console token. It adds nobody else. `:app` may also be `kelay-console`, which is not an app row: its members are the builders, and `role` must be `builder` (the default) or `admin`.
- `PATCH /v1/apps/:app/members/:userId` and `DELETE /v1/apps/:app/members/:userId` (builder token) change a role or plan, ban, unban or remove a member.

**Runs.** The control API also owns `runs`, the record of what was done in each app; Monitoring reads it. Services write to it through the control API (service caller), never directly:

- `POST /internal/v1/runs { runs: [{ app, action, status: "ok" | "blocked" | "error", env?, userId?, args?, ms?, note?, costUsd?, nodes?, at?, caller?: { kind: "user" | "agent" | "app", id?, name? } }] }`, 1 to 500 per request. `nodes` is the per-node record of an agent-graph run: `[{ node, status: "ok" | "error" | "timeout" | "aborted", ms, attempt?, loop?, costUsd? }]`. A run whose caller is an assistant (`kind: "agent"`, `id` = its client id) is tied to the member's consent, which also gives it the assistant's name;
- `POST /internal/v1/mcp-calls { calls: McpCallRecord[] }` from the MCP gateway (§7). Each call becomes a run whose caller is the member's assistant.

Both answer `201 { recorded, skipped }`; records for apps that do not exist are skipped. The builder routes over this data are listed in [`services/control-api/README.md`](../services/control-api/README.md).

## 10. Agent graph (`GraphSpec`)

- **Nodes.** A node lists `next` (one node, or several that run in parallel and share one join node), plus optional `retry`, `timeoutSeconds`, `model` and `review`. Edges through `next` may not form a cycle; the only way back is a review.
- **Parallel.** Branch nodes each point to the same join node, and the join receives their outputs as an array in `next` order. A branch cannot have a review. If one branch fails, the run fails.
- **Retry.** `retry.maxAttempts` counts **retries after the first try**: `2` means up to three invocations. `intervalSeconds` is a whole number of seconds before the first retry (default 1), multiplied by `backoffRate` (default 2) for each later one. `NodeInvocation.attempt` is 1 on the first try. Lambda service errors are always retried, whatever the node says.
- **Review.** A node with `review` must output an object with `approved: boolean`; anything else fails the run with `Kelay.InvalidReviewOutput`. When `approved` is false and this review has rejected fewer than `maxLoops` times, the run goes back to `onReject` with the review's output as its input. Once `maxLoops` rejections are used up, the run continues to `next` as if approved (or ends with the review output). `NodeInvocation.loop` is the number of rejections so far in the run, across all reviews, starting at 0.
- **Execution input** (`GraphExecutionInput`): `{ input, userToken }`. `input` becomes the start node's input (`null` when absent). `userToken` is the user's Kelay ID token; every node receives it and calls the Data API as that user.
- **Execution.** `@kelay/graph` compiles the spec to Step Functions ASL. Node tasks invoke the app's node Lambda with a `NodeInvocation` payload. It also runs the same spec locally for tests and dev.
- **Deploying a graph.** Compile with `functionArn: '${NodeFunctionArn}'` (`NODE_FUNCTION_ARN_PLACEHOLDER`) and send the ASL as `graphs[].definition` to the control API's deploy route, with the node function's bundle as `nodesArtifactUrl` (§14). The deploy driver replaces the placeholder with the node function's alias ARN for that environment.

## 11. Local ports

| Service | Port |
|---|---|
| LLM gateway (LiteLLM) | 4000 |
| Kelay ID | 4001 |
| Data API | 4002 |
| Control API | 4003 |
| MCP gateway | 4004 |
| Run orchestrator | 4007 |
| Console | 3000 |
| Dev sign-in helper (`pnpm dev:up`) | 4005 |
| Builder | 4006 |
| Router (wrangler dev) | 8787 |
| Postgres (compose) | 54320 |

Postgres ports for parallel test containers: policy and SDK 54331, data-api 54332, identity 54333, control-api 54334, mcp-gateway 54335, e2e 54336. The e2e suite's services listen on 4410–4417.

## 12. Models

- All model calls go through the LLM gateway. They use the official Anthropic SDK (`@anthropic-ai/sdk`) with `baseURL = LLM_GATEWAY_URL` and the gateway key.
- The default model is `claude-opus-5-5`; override it with env vars.
- A service or node function without `LLM_GATEWAY_URL` and `LLM_GATEWAY_KEY` still starts. Its model calls fail with an error that begins "LLM gateway not configured". Locally, `pnpm dev:up` starts the gateway only when `ANTHROPIC_API_KEY` is set.
- No consumer subscription logins anywhere.

## 13. Run orchestrator

`services/runner` starts an app's agent graph as the calling user, follows it to the end and records it.

- **Start.** `POST /v1/apps/:app/runs { graph, input?, action? }` → `202 { runId }`.
  - Headers: `authorization: Bearer <user token>` (the `app` claim must equal `:app`; the audience is not checked, as in the Data API, so a screen token and an assistant's MCP token both work) and `x-kelay-caller`.
  - An `app-runtime` caller may start runs of its own app only; the run is a `user` run in that runtime's env.
  - A `service` caller (the MCP · A2A gateway) may also send `env` and `caller: { kind: "agent" | "app", id?, name? }`, naming on whose behalf it starts the run.
  - `action` is the name Monitoring lists the run under; it defaults to the graph name.
  - An app without that graph answers `not_found`.
- **Concurrency.** One user may have `RUNNER_MAX_CONCURRENT_RUNS_PER_USER` runs in progress (default 2), counted across apps. One more answers `rate_limited` with `Retry-After`.
- **Read.** `GET /v1/runs/:id` → `{ run: { id, app, env, graph, action, status: "running" | "succeeded" | "failed", caller, output, error: { name, message, node? } | null, trace, costUsd, startedAt, finishedAt, ms } }`. `?wait=<seconds>` (at most 60) holds the request until the run finishes. Same two headers; only the user who started the run can read it, and anyone else gets `not_found`.
  - `trace` has one entry per node invocation: `{ node, status: "ok" | "error" | "timeout" | "aborted", ms, startedAt, attempt?, loop?, error?, message?, llmCalls?, costUsd? }`.
- **Events.** `GET /v1/runs/:id/events` is a server-sent event stream: `run_started`, `node_started`, `node_finished`, then `run_finished` (with `status`, `ms`, `output` or `error`), after which the stream closes. Events carry increasing ids, and `Last-Event-ID` resumes after one.
- **Drivers** (`RUNNER_DRIVER`):
  - `local` runs the graph in the runner's process with `runLocal` from `@kelay/graph`. `RUNNER_LOCAL_NODES` lists the node code as `<app>=<module>` pairs; each module exports `nodes`, built with `createLocalNodes` from `@kelay/runtime`. The runner mints the app-runtime caller token the nodes call the Data API with.
  - `sfn` runs the state machine `kelay-app-<app>-<env>-<graph>` under `KELAY_STATE_MACHINE_ARN_PREFIX`, with the execution input of §10 and the run id as the execution name. An Express machine is run with `StartSyncExecution`; a Standard one is started, polled, and its history gives the trace. Express executions keep no history, so their trace is empty.
- **Record.** Every finished run goes to `POST /internal/v1/runs` (§9) with its status, duration, caller, per-node metrics and, when the LLM gateway priced the model calls, its cost.
- **State.** Runs in progress and the last hour of finished ones live in the runner's memory, so one runner process serves them. The lasting record is the control API's.

## 14. Node runtime (`@kelay/runtime`)

An app's agent-node function is written against `packages/runtime`. `examples/ticket-board-nodes` implements Ticket Board's `overdue-summary` graph with it.

- **Nodes.** `defineNode(async (ctx) => output)`. The output must be JSON; it becomes the next node's input. `defineNodes(spec, { <node>: … })` pairs a `GraphSpec` with the code of exactly its nodes.
- **Context:**
  - `ctx.input`: the previous node's output; for a join, the branch outputs in `next` order; for the start node, the run input.
  - `ctx.data`: a `@kelay/sdk` client that sends the run's `userToken` and the function's caller token, so every read and write goes through that user's RLS.
  - `ctx.llm`: the official Anthropic SDK client (§12) with `baseURL = LLM_GATEWAY_URL` and the app's gateway key `LLM_GATEWAY_KEY`. Reading it without both throws `Kelay.LlmGatewayNotConfigured` ("LLM gateway not configured: …"), so only nodes that call a model need a gateway.
  - `ctx.model`: the graph node's `model`, else `LLM_MODEL`, else `claude-opus-5-5`.
  - `ctx.run`: `{ runId, app, env, graph, node, attempt, loop }`.
- **Function environment.** `DATA_API_URL` and `KELAY_CALLER_TOKEN` are required; `LLM_GATEWAY_URL`, `LLM_GATEWAY_KEY` and `LLM_MODEL` are optional.
- **In an app.** The node code is `kelay/nodes.ts`, which exports `graphs` (a `defineNodes(...)` per graph of `kelay/graphs.ts`). The Builder bundles it behind `createLambdaHandler` into `nodes.zip`, handler `nodes.handler`, and leaves it out of the app's Next.js build.
- **Hosts.** `createLambdaHandler(graphs)` is the node function's handler: it takes a `NodeInvocation` (§10) and returns the node's output. A thrown error fails the invocation under the error's name. `createLocalNodes(graphs)` is the same code for the run orchestrator's local driver (§13), which supplies the caller token.
- **Usage.** The runtime counts each node's model calls and adds up the cost the gateway reports for them (LiteLLM's `x-litellm-response-cost` response header). The local driver puts both on the run's trace.
