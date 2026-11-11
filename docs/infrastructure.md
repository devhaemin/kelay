# Kelay infrastructure

This document describes what has to run for the prototype in [`design/prototype/index.html`](../design/prototype/index.html) to work for real. The prototype is the source of truth for product behavior. It shows:

- Home: one prompt that builds an agent app.
- My Apps: apps served at `/<handle>/<app>`, plus a shareable store page.
- Workspace tabs: Screen with dev and production, Monitoring, Users with end-user auth and plans, and Feedback with the daily improvement report and tickets.
- A Builder agent chat panel, and a Share modal that hands out the production link.
- App Graph: every app of a builder, linked over MCP and A2A. People share one Keley ID, and their personal agents call the apps over MCP.

It also covers the core scenario:

- permissions as RLS;
- one-step sharing;
- screens that cannot crash on a denied action;
- personal agent VMs with single and shared areas;
- `/feedback` threads;
- MCP and A2A between apps under one identity.

## 1. Decisions

| Area | Choice | Why |
|---|---|---|
| Region | AWS `ap-northeast-2` (Seoul), single region | Users and Kakao sign-in are in Korea. Neon offers only Singapore and Sydney in Asia-Pacific, and Fly.io has no Seoul region. The team already runs ECS. |
| Tenancy | Pooled platform, isolated per app | Each app gets its own runtime functions, Postgres database and role, and storage prefix. Teams and orgs inside an app are separated by RLS. Builders never operate tenancy. |
| Trust boundary | Builder code is untrusted | Agent-written code holds no database password and no model provider key. It reaches data, files and models only through platform services, with a token scoped to the user. |
| App runtime | AWS Lambda per app × env; Next.js packaged with OpenNext | Most small software is idle, so it scales to zero. Each execution environment is a Firecracker microVM. The SDK fixes the stack, so the build is the same for every app. |
| Agent runs | AWS Step Functions, generated from the app's agent graph | The graph in the prototype (Planner → Writer ∥ Designer → Reviewer, with a retry loop) maps onto states with retries, timeouts, parallel branches and per-state metrics. Express workflows cover runs under 5 minutes; Standard covers longer ones. |
| Agent config | Prompts, models and tool configs versioned apart from code, per env | The most common self-improvement change ("writer system prompt", "image tool config") ships without a rebuild. It still goes through eval and publish. |
| Data | Aurora PostgreSQL Serverless v2. One database per app and env, behind a shared Data API and RDS Proxy | Postgres RLS is the permission model. The Data API is the only path to app data, which makes RLS impossible to bypass from builder code. |
| Identity | One Kelay ID for every app (better-auth). Per-app membership holds plan, status and role | The Users tab needs Google, Kakao, GitHub and email sign-in, plus plans and bans. better-auth ships a Kakao provider, an OAuth 2.1 provider and an MCP authorization plugin, so one identity also covers MCP clients. |
| Models | LLM gateway (LiteLLM proxy) | Covers routing across Anthropic, OpenAI and Google, including "Auto"; virtual keys per app and env; per-user budgets by plan; cost per run and per user, as in the user drawer; and BYOK API keys. |
| Sandboxes | ECS Fargate tasks, one microVM each | Used for the Builder agent workspace, implementation runs for approved proposals, and personal agent VMs. The image pre-bakes the fixed SDK toolchain, so a workspace starts from a git checkout. |
| Telemetry | OpenTelemetry → collector → ClickHouse | Powers the Monitoring tab (runs, success rate, p95 latency, cost, node health) and auto-detected tickets. |
| Code | Forgejo, one repo per app | Proposals become branches and diffs. AWS CodeCommit no longer accepts new customers. |
| Edge | Cloudflare DNS, TLS, WAF and CDN, plus a Router Worker | Path routing for `/<handle>/<app>` on the app domain. The Worker signs requests to Lambda function URLs that use IAM auth, so app functions are not public. |

## 2. Stack diagram

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="stack-diagram-dark.png">
  <img src="stack-diagram.png" alt="Kelay infrastructure on AWS Seoul. End users reach Cloudflare, which calls the per-app AWS Lambda web function through a function URL. The web function starts an AWS Step Functions run that invokes per-app agent-node Lambdas. The node Lambdas call the platform through Elastic Load Balancing in the public subnet. In the private platform subnet the load balancer forwards to the LLM gateway, which calls Anthropic, OpenAI and Gemini through NAT, and to the Data API, which checks tokens against Kelay ID and queries Amazon Aurora under RLS. The Console starts AWS Fargate sandboxes that mount Amazon EFS and push to Forgejo. An OTel collector ships telemetry to ClickHouse Cloud." width="100%">
</picture>

- Drawn with the [stack-diagram](https://github.com/caru-ini/stack-diagram) skill.
- [`stack-diagram.html`](stack-diagram.html) is the self-contained source of truth; the PNGs are rendered from it.
- [`stack-diagram.src.html`](stack-diagram.src.html) is the editable draft, with `%%ICON_*%%` tokens. To rebuild it, fetch the icons again with the skill's `fetch_icons.py`; the AWS icon package stays out of the repo.

Reading the diagram:

- **Untrusted** (agent-written): the two Lambda roles marked `untrusted` and the Fargate sandboxes. They hold no secrets.
- **Trusted:** everything behind Elastic Load Balancing in the private platform subnet.
- **Primary path:** user → Cloudflare → app web → Step Functions → agent nodes → load balancer → LLM gateway → model providers.

The same stack as layers, from the outside in:

| Layer | What runs there | Trust |
|---|---|---|
| Edge | DNS, TLS, WAF, CDN; Router Worker with the app route table in Workers KV | Platform |
| Control plane | Console (the real version of the prototype), Control API, Deploy service, feedback triage, Self-Improvement scheduler, Preview proxy | Platform |
| Shared trusted services | Kelay ID, Data API, Storage API, LLM gateway, Run orchestrator, MCP · A2A gateway, OTel collector | Platform; the SDK's only dependencies |
| Per-app plane | Web function and agent node functions for each app and env | Untrusted (agent-written) |
| Sandboxes | Builder workspace, improvement runs, personal agent VMs | Untrusted, isolated per task |
| Data | Control DB, app DBs, S3, Forgejo, ClickHouse | Platform |

## 3. Trust boundary

This boundary is what turns the product's give-ups into guarantees:

- **No tenancy ops for builders.** RLS is the only permission model. The app runtime cannot reach data except through RLS.

The rules:

- **App functions carry no secrets.** No database password, no provider key, no AWS permissions beyond logs. They get a short-lived app token minted at deploy, which identifies the app and env.
- **Every data call carries the end user's JWT** from Kelay ID. Its claims are `sub`, `app`, `org`, `role` and `plan`.
  - The Data API verifies the JWT and opens a transaction as the app's database role (`NOBYPASSRLS`).
  - It sets `request.jwt.claims` and runs the SDK's typed, parameterized query. Builder code cannot send raw SQL.
- **Agents act as someone.** A run started by a user carries that user's token through every node, so agent reads and writes hit the same RLS as the screen ("agents RLS"). Scheduled team jobs carry a delegated token owned by the person who created the job.
- **Files follow the same rules.** The Storage API checks the policy for the collection that owns the file, then returns a presigned S3 URL under the app's prefix.
- **Model calls are metered at the gateway.** The app key sets the provider keys, budgets and routing; the user and run IDs land on every cost record.
- **Screens cannot crash on a denied action.** SDK components check permissions before rendering an action. For example, a ticket you cannot move has no drag handle. When the server still refuses, the component rolls back and shows the reason. QA runs actions per role, not only page loads.

## 4. Flows

### 4.1 Build: Home prompt → dev preview

1. The Console sends the prompt to the Control API, which creates the app, its Forgejo repo and a dev env.
2. The Control API starts a Builder workspace task: an image with the SDK toolchain and the coding agent, with the app repo on an EFS access point.
3. The coding agent writes screens with the SDK and the agent graph spec. It commits on every turn, and runs `next dev`.
4. The Preview proxy maps the dev preview URL to the task over HTTP and WebSocket (HMR). The Router lets only the builder's session through.
5. The workspace stops after 15 idle minutes. Its state lives in git and on EFS, so the next open resumes it.

### 4.2 End-user run

```mermaid
sequenceDiagram
  participant U as End user
  participant R as Router Worker
  participant W as App web (Lambda)
  participant ID as Kelay ID
  participant O as Run orchestrator
  participant N as Agent nodes (Lambda)
  participant G as LLM gateway
  participant DA as Data API
  participant T as Telemetry
  U->>R: GET /handle/app
  R->>W: request signed with SigV4
  W->>ID: session → user JWT (app, org, role, plan)
  U->>W: Generate (product photo)
  W->>O: start run (graph v12, config v31, user JWT)
  O->>N: Planner
  N->>G: model call (app key, user, run)
  G-->>N: output + cost
  O->>N: Writer ∥ Designer
  O->>N: Reviewer (on failure → retry from Planner)
  N->>DA: save page (user JWT → RLS)
  N-->>T: one span per node, cost attributes
  O-->>W: run finished → screen updates
```

### 4.3 Feedback → daily report → approve → publish

```mermaid
sequenceDiagram
  participant EU as End users
  participant F as Feedback intake
  participant TR as Triage worker
  participant SI as Self-Improvement agent
  participant B as Builder
  participant SB as Improvement run (sandbox)
  participant DEV as Dev env
  participant PROD as Production
  EU->>F: /feedback in the app · email · chat
  Note over F: error spikes and node degradation become auto-detected tickets
  F->>TR: raw items
  TR->>TR: classify · dedupe with pgvector · drop noise
  TR-->>B: tickets (New → Triaged)
  SI->>SI: daily — tickets + metrics + sampled traces
  SI-->>B: report with proposals (impact, effort, ticket refs)
  B->>SI: approve selected proposals
  SI->>SB: implement on a branch (code or config)
  SB->>DEV: deploy to dev
  SB->>DEV: QA per role + eval replay of recent real inputs
  DEV-->>B: "Unpublished change" on the Screen tab
  B->>PROD: Publish to production
  PROD-->>EU: reply on the original ticket thread
```

- **Eval replay** re-runs a sample of recent production inputs against the dev config. An LLM judge then compares the outputs with production and checks the ticket's own assertion, for example "label not clipped". The inputs never leave the platform, and an app can opt out.
- **Publish** applies expand-only migrations to the prod database, publishes the agent config version, and switches the Lambda alias from the old version to the new one. Rollback moves the alias back.

### 4.4 One identity, MCP and A2A

- Kelay ID is the OAuth 2.1 authorization server for every app. A person signs in once and appears in each app's Users tab as a member with that app's plan, status and role.
- Every app exposes an MCP server through the MCP · A2A gateway. Its tools are generated from the app's collections and its declared actions; running the agent graph is one tool. The gateway also publishes an A2A agent card.
- MCP clients, including personal agent VMs and other Kelay apps, get resource-bound tokens from Kelay ID. Every tool call therefore runs under the caller's RLS.
- App-to-app links (for example "Meeting Notes → Lead Qualifier: update lead scores") are grants recorded in the Control DB.
  - A pending link waits for Allow or Reject on the App Graph page.
  - The graph, the connection list and the call counts all read from those grants and from gateway telemetry.

### 4.5 Personal agent VMs

- Each team member gets a sandbox task with the coding agent and an MCP client configured for the team's apps.
- **Single area:** a per-user EFS access point that only that user's tasks mount.
- **Shared area:** a per-team EFS access point that every member's tasks and the team's scheduled jobs mount.
- Model access goes through the LLM gateway with the member's own API key (BYOK) or the team's key. Logging in with a Claude subscription inside the VM is out unless Anthropic approves it: the Agent SDK docs disallow third-party products offering claude.ai login.

## 5. Environments

| | Dev | Production |
|---|---|---|
| Code | Branch head, deployed on every approved change | Published version (Lambda alias) |
| Agent config | Draft version | Published version |
| Database | `<app>_dev`, seeded from a masked sample of prod | `<app>_prod` |
| URL | dev preview host; the builder only, or a share link for named testers | `/<handle>/<app>` on the app domain |
| Model budget | Builder's budget | Per-user budgets from the plan |

## 6. Prototype → services

| Prototype surface | Served by |
|---|---|
| Home prompt, "Building your app…" steps | Control API → Builder workspace task |
| My Apps, app cards (users, runs, new feedback) | Control DB (app registry) + ClickHouse rollups |
| Share store page modal (listed and hidden apps) | Control DB store settings; public store route on the Router Worker |
| Screen tab, dev preview, device toggle, "Unpublished change", Publish | Preview proxy → workspace `next dev`; Deploy service for publish |
| Monitoring KPIs, runs and errors chart, recent runs with caller (user, personal agent, other app) | ClickHouse queries over OTel spans and gateway cost records |
| Monitoring connections card | Grants + MCP · A2A gateway call counts |
| Users tab (providers, plans, status, ban, delete, recovery email) | Kelay ID + per-app membership; email through SES |
| Feedback report, proposals, approve, ticket board | Control DB (tickets, proposals) + triage worker + Self-Improvement agent |
| Agent chat panel ("Only you can see this conversation") | Builder workspace session; transcript stored per builder in S3 |
| Deploy, Share modal (production link) | Deploy service; the Router Worker serves the published alias |
| App Graph (apps, MCP / A2A links, Keley ID, personal agents, pending requests, MCP endpoint) | Grants in the Control DB, MCP · A2A gateway, Kelay ID, gateway telemetry |

## 7. Control DB (sketch)

`builders`, `apps` (handle, slug, status), `envs` (dev, prod), `versions` (code commit, config version, Lambda version), `graph_specs`, `agent_configs`, `app_members` (identity, plan, status, role), `grants` (app-to-app and MCP), `tickets`, `ticket_events` (votes, sources, links to runs), `reports`, `proposals` (refs, impact, effort, state), `sandboxes` (task, owner, last active), `budgets`.

## 8. Build order

| Phase | Delivers | Proves |
|---|---|---|
| P0 · spikes (1 week) | OpenNext on Lambda with the current Next.js; Step Functions generated from a three-node graph; Data API + RLS via RDS Proxy; Fargate workspace cold start | The four riskiest assumptions |
| P1 · build and run | Home → workspace → dev preview → publish; one end-user run path through the gateway | Prompt to live app |
| P2 · users and permissions | Kelay ID with Google, Kakao, GitHub and email; memberships and plans; RLS editor; QA actions per role | The Users tab and "내 티켓만" |
| P3 · monitoring | OTel from the SDK and the gateway, ClickHouse, Monitoring tab | Runs, cost, node health |
| P4 · improvement loop | Intake, triage, daily report, approve → implement → eval replay → publish | The Feedback tab end to end |
| P5 · connect | MCP · A2A gateway, grants, App Graph, personal agent VMs | Compounding across apps |

Candidates to reuse, read only at the file and README level so far: `relayax/infra/ecs` (ECS cluster, task definitions, Caddy sync for per-agent routing, Gitea setup, GitHub OIDC, alarms) and `relayax/container/lib/session-manager.js` (agent sessions in containers).

## 9. Risks and open questions

- **Claude subscription login.** Not allowed for third-party products without Anthropic's approval. The gateway path assumes API keys.
- **OpenNext and Next.js versions.** Lambda packaging must keep up with Next.js. P0 checks it before anything else depends on it.
- **Shared Aurora clusters.** One cluster holds many app databases. Shard by app count, and watch connection limits through RDS Proxy.
- **Step Functions limits.** Express workflows stop at 5 minutes and Lambda at 15 minutes. Long image steps move to Standard workflows.
- **Cold starts.** Scale to zero means the first request after idle is slow. This is accepted: millisecond tuning is out of scope. Paid plans can keep one environment warm.
- **Naming.** The prototype says "Keley" and `keley.app`; the repository and plan say "Kelay". Pick one before domains and OAuth apps are registered.

## Sources

- Neon regions: <https://neon.com/docs/introduction/regions>
- Fly.io regions: <https://fly.io/docs/reference/regions> and the open Seoul request at <https://community.fly.io/t/would-fly-io-consider-adding-a-seoul-icn-region/28346>
- better-auth MCP plugin: <https://github.com/better-auth/better-auth/blob/main/packages/mcp/README.md>; Kakao provider: <https://github.com/better-auth/better-auth/blob/main/docs/content/docs/authentication/kakao.mdx>
- Claude Agent SDK on claude.ai login for third-party products: <https://code.claude.com/docs/en/agent-sdk/overview>
