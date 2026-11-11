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
- The next `POST /v1/apps/:app/envs/dev/deploy` turns the draft into the deployed version (same number). The rules reach the database when that version's migration is applied.

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
        "env": "prod", "note": null, "at": "2026-11-11T01:41:00.000Z"
      }
    ]
  }
}
```

- `series` has 24 UTC hours for `24h`, and 14 or 30 UTC days otherwise, oldest first. The three arrays have the same length.
- This is the console's `AppMetrics`. `recent[]` is `RecentAction` plus `args`, `caller`, `env`, `note` and `at`. `by` is a user id; the console resolves the name.
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

- Undoes a reject, or an approve whose improvement run is still queued. The queued run is removed and the tickets the approval moved to `progress` go back to `triaged`.
- `409 conflict` when the run has started or finished, or the proposal is `built`. Undoing a pending proposal returns it unchanged.

### Assistant connections

**`GET /v1/apps/:app/consents`** → `200 { "consents": Consent[] }`: active connections of members' assistants to this app.

**`POST /v1/apps/:app/consents/:id/revoke`** → `200 { "consent": Consent }` with `active: false`. `404 not_found` when the consent is not for this app. Revoking twice returns the revoked consent.

```jsonc
// Consent
{ "id", "userId", "app", "clientId": "<CIMD URL>", "clientName": "Claude Desktop" | null,
  "scopes": ["offline_access"], "createdAt", "lastUsedAt": "<ISO>" | null, "revokedAt": null, "active": true }
```

### Deploy

**`POST /v1/apps/:app/envs/:env/deploy`** with `{ commit, artifactUrl, configVersion, schema?, policy?, graphs? }` → `201`

```jsonc
{ "version": Version, "callerToken": "<jwt>" }   // callerToken only with the local deploy driver
```

- `schema`, `policy` and `graphs` left out of the body carry over from the env's active version. For dev, rules saved with `PUT …/policy` take the place of the active policy.
- Each deploy mints the app-runtime caller token for that app × env (contracts §4) and stores where it went as `version.callerTokenRef`. The `local` driver has nowhere to keep it, so the response carries it; the `aws` driver sets it as `KELAY_CALLER_TOKEN` on the app's functions. `POST /v1/apps/:app/publish` does the same when it creates a prod version.
- The token lasts `CALLER_TOKEN_TTL_SECONDS` (one year by default). A new deploy mints a new one.

## Routes for platform services

**`POST /internal/v1/runs`** → `201 { "recorded": 2, "skipped": 0 }`

```jsonc
{
  "runs": [                                    // 1 to 500
    { "app": "ticket-board", "action": "tickets_update", "status": "ok" | "blocked" | "error",
      "env"?: "dev" | "prod",                  // default "prod"
      "userId"?: "u1", "args"?: "…", "ms"?: 120, "note"?: "…", "costUsd"?: 0.04, "at"?: "<ISO>",
      "caller"?: { "kind": "user" | "agent" | "app", "id"?: "<client id or app slug>", "name"?: "…" } }  // default { kind: "user" }
  ]
}
```

Records for apps that do not exist are skipped and counted in `skipped`.

**`POST /internal/v1/mcp-calls`** with `{ "calls": McpCallRecord[] }` (1 to 500; contracts §7) → `201 { "recorded", "skipped" }`. Each call becomes a run with `caller.kind = "agent"`, linked to the member's consent for that client, and moves that consent's `lastUsedAt`. The MCP gateway posts here when `CONTROL_API_URL` is set.

The other internal routes (`/internal/v1/apps/:app?env=`, members, consents, grants, feedback intake, improvement runs) are described in contracts §6 and §9 and in `src/routes/internal.ts`.
