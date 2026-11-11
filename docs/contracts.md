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
- **Tests that need Postgres** run against a disposable `postgres:17` container on the port listed in §10, and must clean it up.

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
- **Ownership.** `ownerField` names the text column that decides "mine" for the `mine` and `mine_shared` scopes. It defaults to `owner_id`; for tickets the fixture uses `assignee_id`.
- **Actions** may name an agent graph (`graph`) that runs when the action is called.

## 3. Permissions → Postgres RLS (`PolicyMatrix`)

`role → collection → { read, create, update, delete } → scope`. A missing entry means `none`.

**Install order.** Every app database first runs [`packages/contracts/sql/kelay_auth.sql`](../packages/contracts/sql/kelay_auth.sql). It provides:
- `kelay.claims()`, `kelay.uid()`, `kelay.role()`, `kelay.org()`, `kelay.plan()`;
- the `app` schema;
- the `kelay_runtime` role (NOLOGIN, NOBYPASSRLS).

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

## 6. App registry (MVP)

`fixtures/apps.local.json` maps an app slug to its handle, `databaseUrl`, schema and policy (inline or by file). Later the control API serves the same data at `GET /internal/v1/apps/:app`, for service callers.

## 7. MCP · A2A gateway

- **Endpoint.** One MCP server per app at `POST {MCP_PUBLIC_BASE_URL}/:handle/:app/mcp` (Streamable HTTP). The resource URL is exactly that URL.
- **Unauthenticated calls** get `401` with `WWW-Authenticate: Bearer resource_metadata="{MCP_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/:handle/:app/mcp"`. That metadata document (RFC 9728) lists Kelay ID as the authorization server.
- **Tokens.** Verify `aud = resource URL`, `app` and `azp`.
- **Tools generated from `AppSchema`:**
  - `<collection>_list` (where, limit), `<collection>_get` (id), `<collection>_create`, `<collection>_update` (id + values), `<collection>_delete` (id);
  - `action_<name>` for each action.
  - Every tool calls the Data API with the user's token, so RLS applies.
- **Limits.** A token bucket per `sub × app` and per `azp` client, set by `MCP_RATE_PER_MIN` (default 60).
- **Metering.** One JSON log line per call: `{type:"mcp_call", app, sub, client, tool, ms, ok}`.
- **A2A.** The gateway serves an A2A agent card at `/:handle/:app/.well-known/agent-card.json`.

## 8. Kelay ID

- **Stack.** better-auth with Postgres (control DB), using these plugins:
  - `jwt`, with JWKS at `/api/auth/jwks` and issuer `KELAY_ID_ISSUER`;
  - `mcp` and `cimd`, for MCP OAuth 2.1 and the Client ID Metadata Document flow (MCP 2026-07-28; DCR off).
  - Social sign-in: Google, Kakao, GitHub, and email/password in dev.
- **App-scoped token.** `POST /v1/token { app }` with a session returns `{ token }`. Its claims come from `app_members` (contract §9 below) and it uses `aud = kelay:app:<app>`.
- **MCP tokens** are bound to the app's MCP resource URL and carry the same claims plus `azp`. Consent is per user × app × client.

## 9. Control DB tables shared across services

The control API owns the migrations. Other services read only:

- `app_members(app text, user_id text, org text, role text, plan text, status text, primary key (app, user_id))`

## 10. Agent graph (`GraphSpec`)

- **Nodes.** A node lists `next` (one node, or several that run in parallel and share one join node), plus optional `retry`, `timeoutSeconds`, `model` and `review`.
- **Review.** A node with `review` must output `{ approved: boolean }`. If not approved, the run goes back to `onReject`, at most `maxLoops` times.
- **Execution.** `@kelay/graph` compiles the spec to Step Functions ASL. Node tasks invoke the app's node Lambda with a `NodeInvocation` payload. It also runs the same spec locally for tests and dev.

## 11. Local ports

| Service | Port |
|---|---|
| LLM gateway (LiteLLM) | 4000 |
| Kelay ID | 4001 |
| Data API | 4002 |
| Control API | 4003 |
| MCP gateway | 4004 |
| Router (wrangler dev) | 8787 |
| Postgres (compose) | 54320 |

Postgres ports for parallel test containers: policy and SDK 54331, data-api 54332, identity 54333, control-api 54334, mcp-gateway 54335, e2e 54336.

## 12. Models

- All model calls go through the LLM gateway. They use the official Anthropic SDK (`@anthropic-ai/sdk`) with `baseURL = LLM_GATEWAY_URL` and the gateway key.
- The default model is `claude-opus-5-5`; override it with env vars.
- No consumer subscription logins anywhere.
