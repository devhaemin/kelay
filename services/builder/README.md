# Builder

The Builder workspace of [infrastructure §4.1](../../docs/infrastructure.md): one paragraph becomes an app, and Builder chat changes it. Each app gets a workspace: a git repo started from [`templates/starter`](../../templates/starter), a coding agent, and `next dev` as the dev preview.

- **Run:** `pnpm --filter @kelay/builder dev` (port 4006), or `pnpm dev:up`, which starts it with local workspaces.
- **Test:** `pnpm --filter @kelay/builder test`. No database and no model: the Control API and the Agent SDK are replaced, the Fargate driver runs against `aws-sdk-client-mock`.

## A turn

Every request (the Home prompt, a chat message, an approved improvement) is one turn, and a workspace runs one turn at a time:

1. The coding agent changes files in the workspace.
2. The workspace commits.
3. `kelay/schema.ts`, `kelay/policy.ts` and `kelay/graphs.ts` are evaluated in the workspace and checked with `@kelay/policy` and `@kelay/graph`. When the check fails, the problems go back to the agent once; a second failure ends the turn and nothing is deployed.
4. The result is deployed to Development through `POST /v1/apps/:app/envs/dev/deploy` of the Control API with the schema, the policy and the compiled graphs, which migrates the app database.
5. After the first deploy the builder becomes a member of the app with the role `admin` (`PUT /internal/v1/apps/:app/members/:userId` of the Control API), in the org of their console token. An app that declares no `admin` role gives them its first role. Nobody else is added and no data is seeded.
6. The dev preview is started if it is not running.

An improvement run does the same on a branch `improve/<run id>`, which is merged into `main` once it deployed. A workspace nobody used for 15 minutes is stopped; its state is in git and in the Builder's state folder, so the next message resumes it.

## Routes

All take `authorization: Bearer <Kelay ID token for kelay-console>` with role `builder` or `admin`. The Builder asks the Control API for the app with that same token, so only the owner gets in. Errors are `{ "error": { "code", "message" } }` (contracts §0).

| Route | Answer |
|---|---|
| `POST /v1/workspaces` `{ app, prompt }` | `202 { workspace, turn }`. Creates the workspace and starts the first build. `409 conflict` while a turn runs, or for an app that already has a deployed version and no workspace here. |
| `POST /v1/workspaces/:app/messages` `{ text, context? }` | `202 { workspace, turn }`. Starts a chat turn. `409 conflict` while a turn runs. |
| `GET /v1/workspaces/:app` | `200 { workspace }`, or `404 not_found` when the app has no workspace. |
| `GET /v1/workspaces/:app/events` | The transcript, then live events, as SSE. `Last-Event-ID` or `?after=<id>` resumes; `?format=json` answers `{ events }` and ends. |
| `GET /healthz` | `{ ok, service, driver, agent }`, no token. |

```jsonc
// workspace
{ "app": "team-board", "state": "working" | "idle" | "stopped", "driver": "local" | "fargate",
  "agent": { "kind": "claude" | "scripted", "model": "claude-opus-5-5" | null },
  "previewUrl": "http://localhost:55264" | null,
  "lastCommit": { "commit", "message", "branch" } | null, "version": "v2" | null,
  "turn": { "id", "kind": "build" | "message" | "improvement" } | null, "lastEventId": 41 }
```

Events share `{ id, at, app, turn }`; the SSE event name is `type`:

| `type` | Fields |
|---|---|
| `turn.started` | `kind`, `prompt`, `context`, `agent` |
| `step` | `key`, `text`, `status: "running" \| "done" \| "failed"` |
| `assistant.text` | `text` |
| `file` | `path`, `change: "created" \| "modified" \| "deleted"` |
| `commit` | `commit`, `message`, `files`, `branch` |
| `validation` | `ok`, `attempt` (1 or 2), `problems: { path, message }[]` |
| `deploy` | `ok`, `env: "dev"`, `version`, `versionId`, `error` |
| `preview` | `url` |
| `turn.finished` | `status: "succeeded" \| "failed"`, `error` |

## Coding agent

`BUILDER_AGENT=claude|scripted`. Unset, it is `claude` when `ANTHROPIC_API_KEY` is set and `scripted` otherwise. `agent` in `/healthz`, in every workspace and in every `turn.started` says which one is active.

- **`claude`** runs the Claude Agent SDK in the workspace folder. It authenticates only with `ANTHROPIC_API_KEY`: an Anthropic API key, or the LLM gateway's key together with `ANTHROPIC_BASE_URL`. The agent process gets an environment built from scratch and its own config folder, and a turn is stopped if the SDK reports any other credential source, so a claude.ai login is never used. The model is `BUILDER_MODEL` (default `claude-opus-5-5`). It has the file tools `Read`, `Write`, `Edit`, `Glob` and `Grep` and no shell; every call is allowed only inside the workspace folder, never on `.env` files, and writes never on the template's platform files.
- **`scripted`** uses no model. It writes the Ticket Board app from `packages/contracts/fixtures/ticket-board` whatever the prompt says, and knows one follow-up (a priority field on tickets). It exists so the whole flow runs without a key.

## Workspace drivers

`BUILDER_WORKSPACE_DRIVER=local|fargate` (default `local`).

- **`local`**: a folder per app under `KELAY_WORKSPACES_ROOT` (default `.kelay/workspaces` in the repo), sharing the dependencies installed in `templates/starter`. The preview is `next dev` on a free port.
- **`fargate`**: one ECS task per app with the app's own EFS access point, so a task sees only that app's repo. The task runs `src/runtime-server.ts`, and the Builder drives it over the VPC with a token only the two of them know. The task holds the gateway key for the agent and no platform secret; checks and deploys stay in the Builder. Settings: `BUILDER_ECS_CLUSTER`, `BUILDER_EFS_FILE_SYSTEM_ID`, `BUILDER_SUBNETS`, `BUILDER_SECURITY_GROUPS`, `BUILDER_WORKSPACE_IMAGE`, `BUILDER_EXECUTION_ROLE_ARN`, `BUILDER_TASK_ROLE_ARN`, `BUILDER_PREVIEW_URL_TEMPLATE`, and `BUILDER_WORKSPACE_API_KEY` with `ANTHROPIC_BASE_URL` for the agent. This driver has unit tests only; it has not run against AWS, and the workspace image and the preview proxy do not exist yet.

## Other settings

| Variable | Meaning |
|---|---|
| `CONTROL_API_URL`, `KELAY_CALLER_SECRET` | The Control API, and the secret for the Builder's `service` caller token (deploy, improvement runs, sandbox records). Required. |
| `KELAY_ID_ISSUER`, `KELAY_ID_JWKS_URL` | Verify builder tokens. Required. |
| `DATA_API_URL` | Passed to dev previews with `CONTROL_API_URL`, `KELAY_ID_ISSUER` and the runtime's caller token. |
| `APP_DATABASE_URL_TEMPLATE` | When set, the Builder creates the app's Development database from it before the first deploy and registers it at the Control API. `pnpm dev:up` sets it. |
| `BUILDER_HOME` | Where workspaces, transcripts and the agent's config folder live (default `.kelay` in the repo). |
| `BUILDER_IDLE_MINUTES` | Idle time before a workspace stops (default 15). |
| `BUILDER_IMPROVEMENTS=off`, `BUILDER_IMPROVEMENT_POLL_MS` | Turn off the improvement worker, or change how often it asks the Control API for a queued run (default 5000). |

## Data in the dev preview

The preview works on the app's Development database as the person looking at it. Its `/api/kelay` route trades the browser's Kelay ID session for that person's token for the app and adds the caller token of the dev deploy (contracts §4). The builder is signed in at Kelay ID already when the console shows the preview, and is an `admin` member of the app, so the preview has data from the first build on. Anyone else who opens the preview URL is asked to sign in, and is refused unless the builder adds them as a member.

This needs Kelay ID and the Data API to know the app, which they do when they read the app registry from the Control API (`KELAY_APPS_SOURCE=control-api`, set by `pnpm dev:up`), and it needs the preview and Kelay ID on one site so that the session cookie reaches both. Locally both are on `localhost`.

## Known limits

- A workspace created before the preview read the Kelay ID session keeps its old `/api/kelay` route, which answers "Sign in with Kelay ID". It is a platform file: copy `templates/starter/app/api/kelay/[...path]/route.ts` over it.
- Access rules saved as a draft in the console are replaced by the workspace's `kelay/policy.ts` on the next turn's deploy.
