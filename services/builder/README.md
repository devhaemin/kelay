# Builder

The Builder workspace of [infrastructure §4.1](../../docs/infrastructure.md): one paragraph becomes an app, and Builder chat changes it. Each app gets a workspace: a git repo started from [`templates/starter`](../../templates/starter), a coding agent, and `next dev` as the dev preview.

- **Run:** `pnpm --filter @kelay/builder dev` (port 4006), or `pnpm dev:up`, which starts it with local workspaces.
- **Test:** `pnpm --filter @kelay/builder test`. No database and no model: the Control API and the Agent SDK are replaced, the Fargate driver and the S3 store run against `aws-sdk-client-mock`. The suite really builds the scripted Ticket Board app (`next build` through OpenNext, a few seconds each) and calls the handlers of the two zips in a process of their own.

## A turn

Every request (the Home prompt, a chat message, an approved improvement) is one turn, and a workspace runs one turn at a time:

1. The coding agent changes files in the workspace.
2. The workspace commits.
3. `kelay/schema.ts`, `kelay/policy.ts` and `kelay/graphs.ts` are evaluated in the workspace and checked with `@kelay/policy` and `@kelay/graph`.
4. With an artifact store configured, the app's bundles are built and stored (see [Bundles](#bundles)).
5. When the check or the build fails, what it found goes back to the agent once; a second failure ends the turn and nothing is deployed.
6. The result is deployed to Development through `POST /v1/apps/:app/envs/dev/deploy` of the Control API with the bundles' URLs, the schema, the policy and the compiled graphs, which migrates the app database.
7. The dev preview is started if it is not running.

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
| `build` | `ok`, `attempt` (1 or 2), `error` (the end of the build's output) |
| `deploy` | `ok`, `env: "dev"`, `version`, `versionId`, `error` |
| `preview` | `url` |
| `turn.finished` | `status: "succeeded" \| "failed"`, `error` |

## Bundles

`buildAppArtifacts(workspaceDir, { outDir, basePath })` in [`src/artifacts/build.ts`](src/artifacts/build.ts) turns a workspace into what the Control API's `aws` deploy driver creates the app's functions from:

- **`web.zip`**, handler `index.handler`. The Next.js app, packaged for Lambda by [OpenNext](https://opennext.js.org/aws) (`@opennextjs/aws` 4.1, which supports the template's Next.js 16.4) for a function URL: one function, no bucket, table or queue beside it, so pages render on request. OpenNext expects a CDN in front for static files; an app function has none, so [`src/artifacts/web-handler.ts`](src/artifacts/web-handler.ts) is bundled in front of OpenNext's handler and answers the files under `_next/static` and `public/` from the zip.
- **`nodes.zip`**, handler `nodes.handler`. The app's `kelay/nodes.ts` (it exports `graphs`, made with `defineNodes` from `@kelay/runtime`) bundled with esbuild behind `createLambdaHandler`. An app without that file has no node bundle; an app that declares a graph must have it.

The Router forwards the whole path to the function, so the web bundle is built with the Next.js `basePath` `/<handle>/<app>`. The build runs on a copy of the workspace under `.kelay/builds` in the folder that holds the toolchain's lockfile, with an environment of its own (the build runs agent-written code), and `kelay/nodes.ts` is left out of the Next.js build. `KELAY_KEEP_BUILD=1` keeps that copy for inspection.

`BUILDER_ARTIFACT_STORE` says where the bundles go, as `builds/<app>/<commit>/web.zip` and `nodes.zip`:

| Value | Store | Deploy sends |
|---|---|---|
| unset | Nothing is built. | `artifactUrl: workspace://<app>/<commit>`, which only the Control API's `local` deploy driver accepts. |
| `local` | The folder `BUILDER_ARTIFACTS_DIR` (default `artifacts` in `BUILDER_HOME`). | `file://` URLs. |
| `s3` | The bucket `BUILDER_ARTIFACTS_BUCKET` (`AWS_REGION`, the task role's credentials). | `s3://` URLs, which the `aws` deploy driver needs. |

With the `fargate` driver the build runs in the workspace task, which may not write to the bucket: the Builder fetches the two files from the task (`POST /runtime/build`, `GET /runtime/artifacts/<name>.zip`) and uploads them itself.

## Coding agent

`BUILDER_AGENT=claude|scripted`. Unset, it is `claude` when `ANTHROPIC_API_KEY` is set and `scripted` otherwise. `agent` in `/healthz`, in every workspace and in every `turn.started` says which one is active.

- **`claude`** runs the Claude Agent SDK in the workspace folder. It authenticates only with `ANTHROPIC_API_KEY`: an Anthropic API key, or the LLM gateway's key together with `ANTHROPIC_BASE_URL`. The agent process gets an environment built from scratch and its own config folder, and a turn is stopped if the SDK reports any other credential source, so a claude.ai login is never used. The model is `BUILDER_MODEL` (default `claude-opus-5-5`). It has the file tools `Read`, `Write`, `Edit`, `Glob` and `Grep` and no shell; every call is allowed only inside the workspace folder, never on `.env` files, and writes never on the template's platform files.
- **`scripted`** uses no model. It writes the Ticket Board app from `packages/contracts/fixtures/ticket-board` whatever the prompt says, with [`examples/ticket-board-nodes`](../../examples/ticket-board-nodes) as its node code, and knows one follow-up (a priority field on tickets). It exists so the whole flow runs without a key.

## Workspace drivers

`BUILDER_WORKSPACE_DRIVER=local|fargate` (default `local`).

- **`local`**: a folder per app under `KELAY_WORKSPACES_ROOT` (default `.kelay/workspaces` in the repo), sharing the dependencies installed in `templates/starter`. The preview is `next dev` on a free port.
- **`fargate`**: one ECS task per app with the app's own EFS access point, so a task sees only that app's repo. The task runs `src/runtime-server.ts` from the [workspace image](#image), and the Builder drives it over the VPC with a token only the two of them know. The task holds the gateway key for the agent and no platform secret; checks and deploys stay in the Builder. Settings: `BUILDER_ECS_CLUSTER`, `BUILDER_EFS_FILE_SYSTEM_ID`, `BUILDER_SUBNETS`, `BUILDER_SECURITY_GROUPS`, `BUILDER_WORKSPACE_IMAGE`, `BUILDER_EXECUTION_ROLE_ARN`, `BUILDER_TASK_ROLE_ARN`, `BUILDER_PREVIEW_URL_TEMPLATE`, and `BUILDER_WORKSPACE_API_KEY` with `ANTHROPIC_BASE_URL` for the agent. This driver has unit tests only and has not run against AWS; what the task runs is checked with the image (below).

## Image

[`Dockerfile`](Dockerfile) (build it from the repo root) holds Node 22, pnpm, git, the Builder with its build tools, and `templates/starter` with its dependencies installed, so a workspace starts from a git checkout and installs nothing. It runs as uid 1000, the owner of every workspace access point. Its default command is the workspace runtime (`src/runtime-server.ts`, port 4007, `next dev` on 3000), which reads `KELAY_APP`, `KELAY_RUNTIME_TOKEN` and the agent settings above and keeps the repo under `/workspace`. Started with `node --import tsx src/server.ts`, the same image is the Builder service.

```sh
docker build -f services/builder/Dockerfile -t kelay/workspace .
pnpm --filter @kelay/builder verify:image --image kelay/workspace
```

[`scripts/verify-image.ts`](scripts/verify-image.ts) needs Docker only. With a Control API stub and the scripted agent it runs the image both ways: as the workspace task, driven over the runtime protocol the way the `fargate` driver drives it (the bundles are built in the container, fetched, stored, and deployed to the stub; the web bundle then answers in the Lambda runtime emulator image, and the dev preview answers in the container), and as the Builder service, with a build started over its HTTP API.

## Other settings

| Variable | Meaning |
|---|---|
| `CONTROL_API_URL`, `KELAY_CALLER_SECRET` | The Control API, and the secret for the Builder's `service` caller token (deploy, improvement runs, sandbox records). Required. |
| `KELAY_ID_ISSUER`, `KELAY_ID_JWKS_URL` | Verify builder tokens. Required. |
| `DATA_API_URL` | Passed to dev previews with `CONTROL_API_URL` and the runtime's caller token. |
| `APP_DATABASE_URL_TEMPLATE` | When set, the Builder creates the app's Development database from it before the first deploy and registers it at the Control API. `pnpm dev:up` sets it. |
| `BUILDER_HOME` | Where workspaces, transcripts and the agent's config folder live (default `.kelay` in the repo). |
| `BUILDER_IDLE_MINUTES` | Idle time before a workspace stops (default 15). |
| `BUILDER_IMPROVEMENTS=off`, `BUILDER_IMPROVEMENT_POLL_MS` | Turn off the improvement worker, or change how often it asks the Control API for a queued run (default 5000). |

## Known limits

- A dev preview renders the app, but locally its data calls answer "Sign in with Kelay ID": the Data API and Kelay ID read apps from `KELAY_APPS_FILE`, which does not know apps built here.
- Access rules saved as a draft in the console are replaced by the workspace's `kelay/policy.ts` on the next turn's deploy.
