# Control API

The control plane for Kelay apps: apps and members, deploys and versions, feedback and daily reports, app-to-app grants, assistant consents, access rules, monitoring and QA. Contracts are in [`docs/contracts.md`](../../docs/contracts.md).

- **Run:** `pnpm --filter @kelay/control-api dev` (port 4003). Migrate first with `pnpm --filter @kelay/control-api migrate`.
- **Test:** `pnpm --filter @kelay/control-api test`. Tests use a disposable `postgres:17` on port 54334, or the server in `CONTROL_TEST_DATABASE_URL`.

## Who may call what

| Routes | Credentials |
|---|---|
| Builder routes (`/v1/apps…`, `/v1/grants…`, `/v1/proposals…`) | `authorization: Bearer <Kelay ID token for kelay-console>` with role `builder` or `admin`. The builder must own the app, otherwise `403 denied`. |
| End-user routes (`POST /v1/apps/:app/feedback`, `/v1/me/…`) | The user's app token plus `x-kelay-caller` from that app's runtime. |
| Internal routes (`/internal/v1/…`) | `x-kelay-caller` with a `service` caller token. |

Errors are `{ "error": { "code", "message" } }` with the codes and statuses of contracts §0. Timestamps are ISO-8601 strings.

## Routes the console uses

Field names below are the JSON the routes return. Types named `AppSchema`, `PolicyMatrix`, `Scope` and `Op` come from `@kelay/contracts`.

### Apps, members, tickets, reports, grants

These existed before and are unchanged, except:

- `GET /v1/apps` → each app now also has `runs: number | null`, the runs of the last 30 days (`null` when there are none).
- Version objects (`version`, `activeVersion`, `versions[]`) now also have `status: "draft" | "deployed"` and `callerTokenRef: string | null`.
- `GET /v1/apps/:app/versions` lists deployed versions only.

- `GET /v1/apps/:app/members` → each member is the `app_members` row plus the person's Kelay ID profile: `name`, `email`, `provider` (`"google" | "email" | "kakao" | "github"`), `createdAt` and `lastSignInAt` (the start of their newest session). All five are `null` for a user id Kelay ID has no account for. `q` matches the user id, name or email. `PATCH …/members/:userId` answers with the same shape.

**`GET /v1/me`** (a console token, or an app token with that app's `x-kelay-caller`) → `200`

```jsonc
{ "me": { "userId", "name", "email", "provider", "createdAt", "lastSignInAt",   // the Kelay ID profile, as for members
          "app": "kelay-console", "org": "orum", "role": "builder", "plan": "pro",   // from the token
          "handle": "orum" } }                                                  // null until the person creates their first app
```

The profile comes from Kelay ID's `user`, `account` and `session` tables in the control DB, which the control API reads and never writes (`src/services/profiles.ts`).

- `GET /v1/grants` → each grant now also has `callsPerDay`: the runs of the last 24 hours that the source app made in the target app. `calls` stays the running total reported through `POST /internal/v1/grants/calls`.

### App Graph

**`GET /v1/graph/overview`** → `200`

```jsonc
{
  "overview": {
    "people": 12,               // distinct members (not banned) across the builder's apps
    "multiAppPeople": 10,       // of those, members of two or more apps
    "callsPerDay": 61,          // runs of the last 24 hours that came from another app or a member's assistant
    "callsDeltaPct": 18,        // those runs, last 7 days vs the 7 days before; null when there were none before
    "agentCallsPerDay": { "ticket-board": 30 }   // assistant runs of the last 24 hours per app; apps with none are left out
  }
}
```

This is the console's `GraphOverview`. The apps, the links and the connected assistants on the graph come from `GET /v1/apps`, `GET /v1/grants` and `GET /v1/apps/:app/consents`.

### Access rules

**`GET /v1/apps/:app/schema`** → `200`

```jsonc
{
  "schema": AppSchema,            // of the active dev version
  "policy": PolicyMatrix,         // of the active dev version; {} when it has none
  "notes": [],                    // { role, collection, op, from }[]; always empty for now
  "version": { "id", "number", "label": "v3", "createdBy", "createdAt" },
  "draft": null                   // or { "id", "number", "label", "createdBy", "createdAt", "policy": PolicyMatrix }
}
```

`draft` holds rules saved with `PUT …/policy` and not deployed yet. To show what the builder last saved, use `draft?.policy ?? policy`. `404 not_found` when nothing with a schema is deployed to dev.

**`PUT /v1/apps/:app/policy`** with `{ "policy": PolicyMatrix }` → `200`, the same shape as `GET …/schema`, with `draft` set.

- The matrix is checked with `validatePolicy` from `@kelay/policy` against the dev schema. Unknown roles or collections answer `400 invalid_request` and the message lists every problem.
- The rules are stored as a draft version: a copy of the active dev version with the new policy and the next version number. Saving again updates the same draft.
- The next `POST /v1/apps/:app/envs/dev/deploy` turns the draft into the deployed version (same number). That deploy applies the rules to the dev database (see Deploy below).

**`POST /v1/apps/:app/policy/preview`** with `{ "as": "<member userId>", "env"?: "dev" | "prod" }` (`env` defaults to `dev`) → `200`

```jsonc
{
  "preview": {
    "as": { "userId", "role", "org", "plan", "status" },
    "env": "dev",
    "version": { "id", "number", "label", "createdBy", "createdAt" },
    "collections": [
      {
        "collection": "tickets",
        "label": "Tickets",
        "ownerField": "assignee_id",
        "read":   { "scope": Scope, "allowed": true,  "count": 2 },
        "create": { "scope": Scope, "allowed": true },
        "update": { "scope": Scope, "allowed": true,  "count": 1 },
        "delete": { "scope": Scope, "allowed": false, "count": 0 },
        "rows": [                  // newest 50 rows the member can read
          { "id", "label", "ownerId", "createdBy", "shared": false, "canUpdate": true, "canDelete": false }
        ]
      }
    ]
  }
}
```

- The queries run in the app database as that member (their role, org and plan from `app_members`), inside a transaction that is rolled back. `read.count` and `rows` are what RLS returns. `update.count`, `delete.count`, `canUpdate` and `canDelete` apply the deployed version's update and delete rules to those rows.
- `rows[].label` is the row's first required text field; `ownerId` is the collection's `ownerField` value; `createdBy` is `owner_id`. This is the console's `AccessSample` plus the two flags.
- The preview shows the **deployed** rules of that env, not a draft.
- `404 not_found`: the user is not a member, or nothing is deployed. `409 conflict`: the env has no database, or the database does not match the version's schema.

### Monitoring

**`GET /v1/apps/:app/metrics?range=24h|14d|30d`** (`range` defaults to `24h`; optional `env=dev|prod`) → `200`

```jsonc
{
  "metrics": {
    "range": "24h",
    "healthy": true,                                   // fewer than 1 in 20 runs failed in the last 24 hours
    "activeMembers": { "value": 11, "total": 12, "delta": 2 },   // members with a run in the last 7 days; delta vs the 7 days before
    "actionsToday": { "value": 210, "deltaPct": 7 },   // runs in the last 24 hours vs the 24 hours before
    "screenErrors7d": { "value": 0, "note": null },    // failed runs that came from the app's own screens
    "agentActionsToday": 106,                          // runs from members' assistants, last 24 hours
    "llmBudgetTodayUsd": 0.42,                         // sum of costUsd, last 24 hours
    "series": { "buckets": ["2026-11-10T02:00:00.000Z"], "actions": [0], "errors": [0] },
    "recent": [                                        // newest 20 runs
      {
        "id", "action": "tickets_update", "args": "{\"id\":\"…\"}", "by": "<userId or ''>",
        "status": "ok" | "blocked" | "error", "ms": 120,
        "source": "App" | "Claude Desktop (MCP)" | "<other app's name>",
        "caller": { "kind": "user" | "agent" | "app", "id": "<client id or app slug>" | null, "name": string | null },
        "env": "prod", "note": null, "costUsd": 0,
        "nodes": null | [{ "node": "summarize", "status": "ok" | "error" | "timeout" | "aborted", "ms": 900, "attempt"?: 1, "loop"?: 0, "costUsd"?: 0.012 }],  // agent-graph runs only
        "at": "2026-11-11T01:41:00.000Z"
      }
    ]
  }
}
```

- `series` has 24 UTC hours for `24h`, and 14 or 30 UTC days otherwise, oldest first. The three arrays have the same length.
- This is the console's `AppMetrics`. `recent[]` is `RecentAction` plus `args`, `caller`, `env`, `note`, `costUsd`, `nodes` and `at`. `by` is a user id; the console resolves the name.
- An app with no runs answers `200` with zeros.

**`GET /v1/apps/:app/tool-calls?limit=100`** (max 500) → `200`

```jsonc
{
  "toolCalls": [
    { "id", "consentId": "<consent id>" | null, "at", "tool": "tickets_update", "args": "{…}",
      "result": "ok" | "denied" | "error", "note": null,
      "userId", "clientId", "clientName": "Claude Desktop" | null, "ms": 25 }
  ]
}
```

Newest first. This is the console's `ToolCall` plus `userId`, `clientId`, `clientName` and `ms`. `consentId` is `null` when the member's consent was never recorded here.

### QA

**`POST /v1/apps/:app/qa/run`** with optional `{ "env": "dev" | "prod" }` (defaults to `dev`; builder or service caller) → `201 { "qa": Qa }`

**`GET /v1/apps/:app/qa`** (optional `env=`) → `200 { "qa": Qa }` for the latest run, or `404 not_found` when the app has never had one.

```jsonc
// Qa
{
  "id", "app", "env": "dev",
  "status": "passed" | "failed" | "error",   // failed: a check got the wrong answer; error: the run could not finish
  "error": null,                             // why, when status is "error"
  "version": "v3" | null, "versionId",
  "startedBy", "startedAt", "finishedAt",
  "passing": 36, "total": 36,
  "errorsReachedUsers7d": 0,                 // failed runs from the app's screens in the last 7 days
  "checks": [QaCheck],                       // every check
  "roles": [{ "role": "member", "passing": 12, "total": 12, "checks": [QaCheck] }],
  "incidents": [
    { "ticket": "FB-129", "title": "Caught: Error when moving a ticket to Done", "resolved": true,
      "timeline": [{ "at": "<ISO>", "when": "<ISO>", "tone": "red" | "green" | null, "text": "…" }] }
  ]
}

// QaCheck
{ "name": "member can’t delete tickets", "status": "ok" | "bad", "durationMs": 3, "note": null,
  "role": "member", "collection": "tickets", "op": Op, "expected": "allow" | "deny", "actual": "allow" | "deny" | "error" }
```

- The default runner (`PolicyQaRunner`) checks the access rules against the real database: for each role × collection × op it tries the operation as a member with that role and compares the answer with the version's policy. It works on rows it inserts for itself and rolls everything back.
- `Qa` is the console's `QaSummary` (`passing`, `total`, `errorsReachedUsers7d`, `checks`, `incidents`) plus the rest. `QaCheck.status` is never `"wait"`: a run is stored only when it has finished.
- `incidents` are the bug tickets of the last 30 days. `timeline[].when` is an ISO timestamp for the console to format; `text` uses the console's markup (`**bold**`, `` `mono` ``, `[[ref]]`, `_italic_`).
- Another runner can be passed as `qa` to `createControlApi`; it implements `QaRunner` from `src/qa/runner.ts`.

### Proposals

**`POST /v1/proposals/:id/undo`** → `200 { "proposal": Proposal }` with `status: "pending"` and `run: null`.

- Undoes a reject, or an approve whose improvement run is still queued or has failed. A queued run is removed, and the tickets the approval moved to `progress` go back to `triaged`.
- `409 conflict` when the run is running or succeeded, or the proposal is `built`. Undoing a pending proposal returns it unchanged.

### Assistant connections

**`GET /v1/apps/:app/consents`** → `200 { "consents": Consent[] }`: active connections of members' assistants to this app.

**`POST /v1/apps/:app/consents/:id/revoke`** → `200 { "consent": Consent }` with `active: false`. `404 not_found` when the consent is not for this app. Revoking twice returns the revoked consent.

Kelay ID records a consent here (`PUT /internal/v1/consents`) each time a person allows an assistant on its consent screen. Revoking, from here or from `POST /v1/me/consents/:id/revoke`, is the only way to end a connection. In the same transaction it deletes what Kelay ID keeps for that user, app and client in the control DB: the consent row (better-auth's `oauthConsent`) and the refresh tokens (`oauthRefreshToken`). Kelay ID looks the consent row up on every token grant, so the assistant's next refresh fails with `invalid_grant`, connecting again asks the person again, and a refresh token from before the revoke stays dead after that. These are the only Kelay ID tables the control API writes.

```jsonc
// Consent
{ "id", "userId", "app", "clientId": "<CIMD URL>", "clientName": "Claude Desktop" | null,
  "scopes": ["offline_access"], "createdAt", "lastUsedAt": "<ISO>" | null, "revokedAt": null, "active": true }
```

### Deploy

**`POST /v1/apps/:app/envs/:env/deploy`** with `{ commit, artifactUrl, nodesArtifactUrl?, configVersion, schema?, policy?, graphs? }` → `201`

```jsonc
{ "version": Version, "callerToken": "<jwt>" }   // callerToken only with the local deploy driver
```

- `artifactUrl` is the web function's bundle (handler `index.handler`) and `nodesArtifactUrl` the node function's (`nodes.handler`); the Builder builds and stores both (`services/builder`, "Bundles"). The `aws` driver takes `s3://<bucket>/<key>` only. A deploy of the active build again (the same `artifactUrl`) keeps that version's `nodesArtifactUrl`; without one, the node function is created from `artifactUrl` too.
- `schema`, `policy` and `graphs` left out of the body carry over from the env's active version. For dev, rules saved with `PUT …/policy` take the place of the active policy.
- Each deploy mints the app-runtime caller token for that app × env (contracts §4) and stores where it went as `version.callerTokenRef`. The `local` driver has nowhere to keep it, so the response carries it; the `aws` driver sets it as `KELAY_CALLER_TOKEN` on the app's functions. `POST /v1/apps/:app/publish` does the same when it creates a prod version.
- The token lasts `CALLER_TOKEN_TTL_SECONDS` (one year by default). A new deploy mints a new one.
- **App database.** Before the driver runs, a deploy applies the version's schema and access rules to the env's database: `migrationSql(schema, policy)` from `@kelay/policy`, through the `AppDatabaseMigrator` passed to `createControlApi` as `appMigrator` (default `PgAppDatabaseMigrator`). `POST /v1/apps/:app/publish` does the same for the prod database, also when it only moves the alias back to an older version, so the database always enforces the rules of the version that is live.
  - The database is the env's `databaseUrl`. An env without one gets it from `APP_DATABASE_URL_TEMPLATE` (`{app}`, `{env}`); with neither, the migration is skipped and logged as `app_db_migration_skipped`. The same holds for the `local` and the `aws` driver.
  - A version with a schema and no policy gets RLS with no policies: every row is denied. A version without a schema is not migrated.
  - The migration connects as the login role in the URL, which must be the role the Data API connects with (contracts §3). When it fails, the deploy answers `500 internal` and no version is recorded.

## Routes for platform services

**`POST /internal/v1/runs`** → `201 { "recorded": 2, "skipped": 0 }`

```jsonc
{
  "runs": [                                    // 1 to 500
    { "app": "ticket-board", "action": "tickets_update", "status": "ok" | "blocked" | "error",
      "env"?: "dev" | "prod",                  // default "prod"
      "userId"?: "u1", "args"?: "…", "ms"?: 120, "note"?: "…", "costUsd"?: 0.04, "at"?: "<ISO>",
      "nodes"?: [{ "node", "status", "ms", "attempt"?, "loop"?, "costUsd"? }],  // per-node metrics of an agent-graph run, at most 200
      "caller"?: { "kind": "user" | "agent" | "app", "id"?: "<client id or app slug>", "name"?: "…" } }  // default { kind: "user" }
  ]
}
```

Records for apps that do not exist are skipped and counted in `skipped`. The run orchestrator posts one record per agent-graph run. A run whose caller is `{ kind: "agent", id: <client id> }` is linked to the member's consent for that client, which gives it the assistant's name when the record has none.

**`POST /internal/v1/mcp-calls`** with `{ "calls": McpCallRecord[] }` (1 to 500; contracts §7) → `201 { "recorded", "skipped" }`. Each call becomes a run with `caller.kind = "agent"`, linked to the member's consent for that client, and moves that consent's `lastUsedAt`. The MCP gateway posts here when `CONTROL_API_URL` is set.

**`PUT /internal/v1/sandboxes`** with `{ "taskArn", "owner", "app", "kind": "workspace" | "improvement", "status": "running" | "stopped" }` → `200 { "sandbox" }`. The Builder ([`services/builder`](../builder/README.md)) calls it when it starts, uses and stops a workspace; there is one row per `taskArn` (an ECS task ARN, or `local:<dir>`), and each call moves `lastActive`.

The other internal routes (`/internal/v1/apps/:app?env=`, members, consents, grants, feedback intake, improvement runs) are described in contracts §6 and §9 and in `src/routes/internal.ts`.
