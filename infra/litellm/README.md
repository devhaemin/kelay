# LLM gateway (LiteLLM)

Every model call in Kelay goes through one LiteLLM proxy ([contracts §12](../../docs/contracts.md)). The gateway holds the provider keys, so services and app code never do. It also enforces per-app and per-user budgets and records the cost of every call against an app, a user and a run.

| File | Purpose |
|---|---|
| `config.yaml` | Models, routing, fallbacks, settings. The same file runs locally and on ECS. |
| `Dockerfile` | `ghcr.io/berriai/litellm:v1.106.6` with `config.yaml` baked in; CI pushes it to the `llm-gateway` ECR repo. |
| [`../local/compose.services.yml`](../local/compose.services.yml) | Local gateway on `localhost:4000`. |

## Models

| `model` in a request | Provider model | Notes |
|---|---|---|
| `claude-opus-5-5` | `anthropic/claude-opus-5-5` | Platform default. `default` is an alias for it. Falls back to Sonnet. |
| `claude-sonnet-5-5` | `anthropic/claude-sonnet-5-5` | Falls back to Haiku. |
| `claude-haiku-5-5` | `anthropic/claude-haiku-5-5` | |
| `gpt-6-astra` | `openai/gpt-6-astra` | Current OpenAI flagship. |
| `gemini-4-carbon` | `gemini/gemini-4-carbon` | Current Gemini flagship (AI Studio API). |

Models live in git (`store_model_in_db: false`). To add or swap one, edit `config.yaml` and redeploy.

The LiteLLM image's bundled cost map at v1.106.6 lacks `gemini-4-carbon`. LiteLLM fetches the current map at startup, which works from ECS through NAT. If you set `LITELLM_LOCAL_MODEL_COST_MAP=True`, add explicit costs under that model's `model_info`.

## Calling the gateway (Anthropic SDK)

Services use the official Anthropic SDK against LiteLLM's Anthropic-native `/v1/messages` endpoint. That endpoint also serves the OpenAI and Gemini models in the table. Set `baseURL` to the gateway root without `/v1`: the SDK appends `/v1/messages` itself. LiteLLM accepts the key the SDK sends in `x-api-key`. Streaming and `/v1/messages/count_tokens` work too.

```ts
import Anthropic from "@anthropic-ai/sdk";

const llm = new Anthropic({
  baseURL: process.env.LLM_GATEWAY_URL, // http://localhost:4000 locally
  apiKey: process.env.LLM_GATEWAY_KEY,  // a LiteLLM virtual key, never a provider key
});

const message = await llm.messages.create(
  {
    model: process.env.KELAY_MODEL ?? "claude-opus-5-5",
    max_tokens: 16000,
    messages: [{ role: "user", content: "Summarize today's overdue tickets." }],
  },
  {
    headers: {
      "x-litellm-end-user-id": `${app}:${userId}`,
      "x-litellm-tags": `app:${app},env:${env},run:${runId},node:${node}`,
      "x-litellm-spend-logs-metadata": JSON.stringify({ run_id: runId, node }),
    },
  },
);
```

- **End user.** Send `x-litellm-end-user-id`, namespaced by app (`<app>:<sub>`), because budgets are per app × user. Don't put user ids in the Anthropic body's `metadata.user_id`: LiteLLM treats that as the end user too, so per-session ids become separate customers.
- **Run attribution.** `x-litellm-tags` and `x-litellm-spend-logs-metadata` land on every spend log row. Monitoring reads cost per run, node and user from those rows.
- **Model ids.** Use exact ids from the table, or `default`. Don't send sampling parameters (`temperature`, `top_p`, `top_k`): current Claude models reject them.

## Keys and budgets

The Control API manages these through LiteLLM's admin API, authenticated with the master key (`LITELLM_MASTER_KEY`). The master key never leaves the Control API and the gateway task.

### One team and one virtual key per app × env

```http
POST /team/new
{ "team_id": "app:ticket-board:prod", "team_alias": "orum/ticket-board (prod)",
  "models": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  "max_budget": 200, "budget_duration": "30d",
  "metadata": { "app": "ticket-board", "env": "prod", "handle": "orum" } }

POST /key/generate
{ "team_id": "app:ticket-board:prod", "key_alias": "app/ticket-board/prod",
  "models": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  "rpm_limit": 600,
  "metadata": { "app": "ticket-board", "env": "prod" } }
```

- **Tags go on requests, not keys.** Key-level `tags` on `/key/generate` is a LiteLLM Enterprise feature (403 without `LITELLM_LICENSE`). The `x-litellm-tags` request header works in the open-source proxy and lands in `LiteLLM_SpendLogs.request_tags`. Both were checked against v1.106.6.
- The Deploy service stores the returned key with the app's env and injects it into the app's node functions as `LLM_GATEWAY_KEY`.
- The key only works for the listed models, inside the team budget and rate limits. A leaked key can therefore spend one app's budget, and nothing more.
- Revoke the key with `/key/delete`. Rotate it with `/key/regenerate` on publish.
- The dev env gets its own team, funded from the builder's budget ([infrastructure §5](../../docs/infrastructure.md)).

### Per-user budgets from the plan

Budget tiers mirror the plans in each app's Users tab:

```http
POST /budget/new  { "budget_id": "plan-free", "max_budget": 1,  "budget_duration": "30d", "rpm_limit": 20 }
POST /budget/new  { "budget_id": "plan-pro",  "max_budget": 20, "budget_duration": "30d", "rpm_limit": 120 }
```

- **Assigning a tier.** When a membership is created or its plan changes, the Control API registers the end user against the tier:

  ```http
  POST /customer/new
  { "user_id": "ticket-board:<sub>", "budget_id": "plan-pro" }
  ```

  Use `/customer/update` when the plan changes.
- **Default tier.** To put unknown end users on the free tier, uncomment `max_end_user_budget_id: plan-free` in `config.yaml` once that budget exists. The float setting `max_end_user_budget` is no longer enforced.
- **Over budget.** A call is refused when either the app's team budget or the user's tier is spent.

### Service keys

Platform services (feedback triage, Self-Improvement, the Builder workspace) use their own virtual keys with `"metadata": { "service": "<name>" }`. The `llm-gateway-key` secret in Terraform holds the key used by control-api. Each builder workspace receives a short-lived key, created per session (`duration: "1d"`), passed as a RunTask override.

### BYOK

An app that brings its own provider key needs per-team model credentials. That requires `store_model_in_db: true` and a `LITELLM_SALT_KEY` that never changes, so credentials stored in the database stay readable. This is not enabled yet.

## Running

**Locally** (from the repo root, with `ANTHROPIC_API_KEY` in `.env`):

```sh
docker compose -f docker-compose.yml -f infra/local/compose.services.yml up -d litellm
curl -s localhost:4000/health/liveliness
```

The local master key is `LLM_GATEWAY_KEY` from `.env` (default `sk-kelay-dev`), so local services can use it directly. LiteLLM keeps its keys and spend logs in a `litellm` database on the compose Postgres, created by the `litellm-db-init` one-shot service.

**On ECS** the `llm-gateway` service in `infra/terraform` runs the image built from this directory. It reads these secrets from Secrets Manager:

- `litellm-master-key`
- `litellm-salt-key`
- `litellm-database-url`: the `litellm` database through RDS Proxy
- `anthropic-api-key`, `openai-api-key` and `gemini-api-key`

It runs with `DISABLE_ADMIN_UI=True`. Health checks hit `/health/liveliness`, which needs no auth and makes no model calls. Avoid plain `/health`: it calls every model.
