# First deploy

How to bring up one Kelay environment (`staging` first, then `prod`) from an empty AWS account and an empty Cloudflare zone. It is written for the person who runs the commands.

> **Nothing here has been run against a real account.** What has been checked without one is listed under [What was verified](#what-was-verified). Treat the first staging deploy as the test of this document, and correct it where it is wrong.

After this runbook the base infrastructure exists and eight services answer: `control-api`, `identity`, `data-api`, `mcp-gateway`, `llm-gateway`, `console`, `builder` and `otel-collector`. Read [What is still open](#what-is-still-open) before you start: it lists what a working product still needs beyond this.

## What you need

| Thing | Detail |
|---|---|
| AWS account | One per environment. Credentials that can create everything in `infra/terraform` (admin-equivalent). |
| Cloudflare zone | One per environment, on your account. An API token with: Zone DNS edit, Zone Settings edit, Zone WAF edit, Workers Routes edit, Workers Scripts edit, Workers KV Storage edit. |
| A second Cloudflare token | For the control API, which writes app routes to Workers KV: the permission Workers KV Storage edit on the account, and nothing else. It goes into a secret in step 5. |
| ACM certificate | In `ap-northeast-2`, for `*.<zone>` and `<zone>`, validated through DNS in Cloudflare. |
| Tools | Terraform 1.17.2, AWS CLI v2, Docker, Node 22, pnpm 10.4.1, `jq`. `wrangler` comes with `pnpm install`. |
| Provider keys | An Anthropic API key. An OAuth client id and client secret for each sign-in provider you want (Google, Kakao, GitHub). |

Every script in `infra/deploy` prints what it would do and changes nothing. Add `--execute` to run it. Read the dry run first, every time.

```sh
export AWS_ACCOUNT_ID=111111111111 ENV=staging
pnpm install
```

## Order

### 1. State bucket (once per account)

```sh
infra/deploy/bootstrap-state.sh --account $AWS_ACCOUNT_ID            # read it
infra/deploy/bootstrap-state.sh --account $AWS_ACCOUNT_ID --execute
```

### 2. Configure the env root

```sh
cd infra/terraform/envs/$ENV
echo "bucket = \"kelay-tfstate-$AWS_ACCOUNT_ID\"" > backend.hcl
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`: account id, Cloudflare account id, zone, app hostname, certificate ARN. Delete `image_tag` and `service_overrides` from it: step 3 renders them into their own var file, and Terraform would ignore the copies here.

Decide how people sign in to Kelay ID, in the same file:

- `identity_social_providers`: any of `google`, `kakao`, `github`. Terraform creates a `<provider>-client-id` and a `<provider>-client-secret` secret for each one listed, and Kelay ID cannot start until both have values (step 5).
- `identity_email_password = true` turns on sign-in with an email address and a password.

With no provider and no email sign-in, nobody can sign in.

Sizes and counts of the services live in [`infra/deploy/services/<env>.json`](../infra/deploy/services). A plain setting for one service goes there too, as `"<service>": { "env": { "NAME": "value" } }`; it is added to the settings in `main.tf`. The Builder (`builder`) runs as one task, because it keeps the state of its workspaces itself; the file may not give it more.

### 3. First apply

Terraform uploads the Router Worker bundle, so build it first. The image tag is the commit you will build images from in step 6.

```sh
cd "$(git rev-parse --show-toplevel)"
TAG=$(git rev-parse --short=12 HEAD)
pnpm --filter @kelay/router build
node infra/deploy/render-services.mjs --env $ENV --tag $TAG --out infra/deploy/out/$ENV/services.tfvars.json

cd infra/terraform/envs/$ENV
export CLOUDFLARE_API_TOKEN=...
terraform init -backend-config=backend.hcl
terraform plan -var-file=../../../deploy/out/$ENV/services.tfvars.json -out=tfplan
terraform apply tfplan
```

Read the plan before applying. A first apply takes 20 to 40 minutes, most of it Aurora and the RDS Proxy. The ECS services are created now and cannot start yet: their database logins, secrets and images come next. That is expected.

### 4. Database logins

No service uses the Aurora master user. Terraform wrote two logins to Secrets Manager, `kelay-$ENV/db-platform` (the control API, Kelay ID and the Data API) and `kelay-$ENV/db-litellm` (the LLM gateway), and told RDS Proxy about them. They do not exist in Postgres yet. The `db-bootstrap` task creates them as the master user, makes `kelay_platform` the owner of `kelay_control`, and creates the `litellm` database:

```sh
CLUSTER=kelay-$ENV
NET=$(aws ecs describe-services --cluster $CLUSTER --services control-api --query 'services[0].networkConfiguration' --output json)
TASK=$(aws ecs run-task --cluster $CLUSTER --launch-type FARGATE --network-configuration "$NET" \
  --task-definition "$(terraform output -raw db_bootstrap_task_family)" --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster $CLUSTER --tasks $TASK
aws ecs describe-tasks --cluster $CLUSTER --tasks $TASK --query 'tasks[0].containers[0].[exitCode,reason]'
```

The exit code must be `0`. Its log is in `/kelay/$ENV/db-bootstrap` and ends with `db-bootstrap: roles … are ready`. The task can run again at any time; it changes nothing that is already right.

### 5. Secrets

```sh
cp infra/deploy/secrets.env.example infra/deploy/secrets.$ENV.env     # ignored by git
```

Fill it in. The file explains each value; none of them is a database password or a database URL.

```sh
infra/deploy/set-secrets.sh --env $ENV --file infra/deploy/secrets.$ENV.env            # shows names and lengths only
infra/deploy/set-secrets.sh --env $ENV --file infra/deploy/secrets.$ENV.env --execute
```

ECS cannot start a task while any secret it references is empty. Give every secret a value, `unused` for the ones you do not have (`openai-api-key`, `gemini-api-key`).

`cloudflare-kv-token` is the second Cloudflare token of the table above. With a wrong one the control API still starts and still deploys; each deploy then answers `route.published: false` with Cloudflare's reason, and the app is not reachable on the app domain until a later deploy or publish writes its route.

### 6. Images

```sh
infra/deploy/build-images.sh --env $ENV --account $AWS_ACCOUNT_ID --push            # read it
infra/deploy/build-images.sh --env $ENV --account $AWS_ACCOUNT_ID --push --execute
```

It builds the nine images of [`infra/deploy/images.json`](../infra/deploy/images.json) for `linux/amd64` and pushes them as `kelay-$ENV/<service>:$TAG`. `builder` and `workspace` are one Dockerfile ([`services/builder/Dockerfile`](../services/builder/Dockerfile)): the Builder service, and the task it starts for each app's workspace. It is the largest image (about 2.7 GB), because it holds the toolchain every app is built with. The repositories are tag-immutable; a tag that is already there is skipped. The tag must be the one from step 3. If you committed since, render and apply again with the new tag.

### 7. Migrate the control DB

`control-api` does not migrate on start. Run its migration as a one-off task:

```sh
TASK=$(aws ecs run-task --cluster $CLUSTER --launch-type FARGATE --task-definition kelay-$ENV-control-api \
  --network-configuration "$NET" --query 'tasks[0].taskArn' --output text \
  --overrides '{"containerOverrides":[{"name":"control-api","command":["node","dist/migrate.js"]}]}')
aws ecs wait tasks-stopped --cluster $CLUSTER --tasks $TASK
```

It logs `migrations applied` to `/kelay/$ENV/control-api`. Kelay ID creates its own tables when it starts. App databases need no step: the control API creates an env's database the first time a version is deployed to it.

### 8. Start the services

ECS retries on its own, but slowly. Force it:

```sh
for s in control-api llm-gateway identity data-api mcp-gateway builder console otel-collector; do
  aws ecs update-service --cluster $CLUSTER --service $s --force-new-deployment --query service.serviceName
done
```

The order does not matter. Kelay ID, the Data API and the MCP gateway read apps from the control API ([contracts §6](contracts.md)); while it is not up yet they start without apps and ask again.

### 9. Router

Terraform deployed the Worker in step 3 with the bindings it reads (`MCP_ORIGIN`, `CONTROL_ORIGIN`, `AWS_REGION`, `ROUTES`). Give it the AWS key it signs Lambda calls with:

```sh
aws iam create-access-key --user-name kelay-$ENV-router
pnpm --filter @kelay/router exec wrangler secret put AWS_ACCESS_KEY_ID --name kelay-$ENV-router
pnpm --filter @kelay/router exec wrangler secret put AWS_SECRET_ACCESS_KEY --name kelay-$ENV-router
```

Later Router code can ship without a Terraform run:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
terraform -chdir=infra/terraform/envs/$ENV output -json > infra/deploy/out/$ENV/tf-outputs.json
node infra/deploy/render-router-config.mjs --env $ENV --outputs infra/deploy/out/$ENV/tf-outputs.json --out infra/deploy/out/$ENV/wrangler.json
pnpm --filter @kelay/router exec wrangler deploy --config "$PWD/infra/deploy/out/$ENV/wrangler.json" --dry-run
pnpm --filter @kelay/router exec wrangler deploy --config "$PWD/infra/deploy/out/$ENV/wrangler.json"
```

Routes for apps need no step. The control API writes an app's entry to the Worker's `ROUTES` namespace on every deploy and publish (`ROUTE_STORE=cloudflare-kv`, with the `cloudflare-kv-token` secret): `app:<handle>/<app>` → `{"dev":{"origin","region"},"prod":{…}}`, the function URL of each env the app is deployed to. To read an entry:

```sh
pnpm --filter @kelay/router exec wrangler kv key get "app:<handle>/<app>" --remote \
  --namespace-id "$(terraform -chdir=infra/terraform/envs/$ENV output -raw routes_kv_namespace_id)"
```

## Verification

| Check | Expected |
|---|---|
| `aws ecs describe-services --cluster kelay-$ENV --services control-api identity data-api mcp-gateway llm-gateway builder console otel-collector --query 'services[].[serviceName,runningCount,desiredCount]'` | Running equals desired. |
| `curl -s https://api.<zone>/healthz` | `{"ok":true,"service":"control-api","db":"ok","deployDriver":"aws","routeStore":"cloudflare-kv",...}` |
| `curl -s https://preview.<zone>/healthz` | `{"ok":true,"service":"builder","driver":"fargate","agent":{"kind":"claude",...}}` |
| `curl -s -o /dev/null -w '%{http_code}' https://preview.<zone>/preview/nothing/` | `401`: a dev preview opens only from the console, for the app's builder. |
| `curl -s https://id.<zone>/healthz`, `https://id.<zone>/.well-known/oauth-authorization-server` | `{"ok":true}` and metadata whose `issuer` is `https://id.<zone>`. |
| `curl -s https://data.<zone>/healthz`, `https://mcp.<zone>/healthz`, `https://console.<zone>/healthz` | `{"ok":true}` each (the console adds `"service":"console"`). |
| `curl -s https://llm.<zone>/health/liveliness` | `200` |
| `curl -s -o /dev/null -w '%{http_code}' https://otel.<zone>/v1/traces -H 'content-type: application/json' -d '{"resourceSpans":[]}'` | `200` |
| `curl -s -o /dev/null -w '%{http_code}' https://api.<zone>/internal/v1/apps` | `403` from Cloudflare: internal routes are blocked at the edge. |
| `curl -s https://<app host>/nobody/nothing` | JSON `unknown_app` from the Router. |
| `curl -s https://<app host>/.well-known/oauth-protected-resource/nobody/nothing/mcp` | JSON `unknown_app` from the MCP gateway, which asked the control API. `internal` here means the gateway cannot reach the control API or its caller secret differs. |
| Log group `/kelay/$ENV/identity` | A line `{"type":"apps","service":"identity","count":0}`, and no `registry_error` lines after the control API is up. |
| CloudWatch alarms of `kelay-$ENV` | `OK` or `INSUFFICIENT_DATA`, none in `ALARM`. |

When a service does not come up, read its stopped task first: `aws ecs describe-tasks` shows `stoppedReason` (a missing image or an empty secret appears here, not in the logs). Then the log group `/kelay/$ENV/<service>`. A `password authentication failed` there means step 4 has not run since the logins last changed.

## Rotating the database logins

RDS rotates the master password on its own, and nothing depends on it. The two service logins change only when you say so:

1. Raise `db_password_version` in `terraform.tfvars`, plan and apply. Terraform writes new passwords to the two secrets.
2. Run the `db-bootstrap` task (step 4) at once. Between the apply and the task, the proxy offers the new password while Postgres still has the old one, so new connections fail.
3. Restart the services (step 8). A task reads its login when it starts.

## Rollback

- **A bad image.** ECS rolls a failed deployment back by itself (circuit breaker). To go back on purpose, render the var file with the previous tag (`--tag <old>`, or `--set <service>=<old>` for one service), plan and apply. Old tags stay in ECR; the last 50 images are kept.
- **A bad Terraform change.** Check out the previous commit, plan, read it, apply. Do not edit state by hand.
- **A bad control DB migration.** Migrations only go forward. Restore the cluster to a point in time (`aws rds restore-db-cluster-to-point-in-time`) into a new cluster and repoint, or write a forward fix. Take a snapshot before step 7 on any environment that holds data.
- **The Router.** `pnpm --filter @kelay/router exec wrangler rollback --name kelay-$ENV-router` returns to the previous version.
- **A route.** An app's entry follows its deployments: publishing an earlier version writes it again, and archiving the app deletes it. To take an app off the Router by hand, delete its key: `wrangler kv key delete "app:<handle>/<app>" --namespace-id <id> --remote`. The Router caches an entry for 60 seconds.
- **Everything (staging only).** `terraform destroy` works while `deletion_protection = false`. Secrets stay recoverable for 7 days, which blocks an immediate re-create under the same names.

## Later deploys with GitHub Actions

[`ci.yml`](../.github/workflows/ci.yml) runs on pull requests and on `main`: typecheck, unit tests, e2e, `terraform fmt`, `validate` and `test` for both envs, workflow and script lint, and a build of every image with no push. It needs no secrets.

[`deploy.yml`](../.github/workflows/deploy.yml) runs only when someone starts it (`workflow_dispatch`). No push, merge or schedule triggers it. Its inputs choose the environment and which steps run: push images, plan, apply, deploy the Router. Apply and the Router deploy wait for approval.

### GitHub setup

Create two GitHub Environments per env. `<env>` has no protection rules. `<env>-apply` has **required reviewers**; that is the approval gate.

| Name | Kind | `<env>` | `<env>-apply` |
|---|---|---|---|
| `AWS_ROLE_ARN` | variable | Role that may push to ECR and run `terraform plan` (read access, plus read and write on the state bucket). | Role that may apply. |
| `AWS_ACCOUNT_ID` | variable | yes | yes |
| `TF_STATE_BUCKET` | variable | yes | yes |
| `TERRAFORM_TFVARS` | variable | The contents of `terraform.tfvars` from step 2. No secrets belong in it. | no |
| `CLOUDFLARE_ACCOUNT_ID` | variable | no | yes |
| `CLOUDFLARE_API_TOKEN` | secret | yes | yes |
| `CLICKHOUSE_ORG_ID`, `CLICKHOUSE_CLOUD_API_KEY`, `CLICKHOUSE_CLOUD_API_SECRET` | variable, secret, secret | Only with `enable_clickhouse = true`. | same |

The roles trust GitHub's OIDC provider (`token.actions.githubusercontent.com`) in the account. Limit each with a condition on `token.actions.githubusercontent.com:sub`: `repo:devhaemin/kelay:environment:<env>` for the first role and `repo:devhaemin/kelay:environment:<env>-apply` for the second. A workflow run outside those environments then cannot assume either.

The plan job stores the plan file as an artifact for one day so the apply job applies exactly what was reviewed. A plan file can contain sensitive values from state. Keep the repository private, or stop uploading it and plan again in the apply job.

The first apply of an environment is better done by hand (steps 1 to 9): the workflow pushes images before it plans, and the ECR repositories do not exist until the first apply.

## Monthly cost drivers

Rough guide, not a quote. Check current `ap-northeast-2` prices before you commit to an environment.

| Driver | What sets it | Note |
|---|---|---|
| NAT gateways | 1 in staging, 2 in prod, plus per-GB traffic | Fixed hourly charge whether or not anything runs. Model calls and image pulls pass through it. |
| RDS Proxy | Hours | Billed on the cluster's capacity with a minimum, so it costs more than an idle Serverless v2 cluster. Its open connections can also keep Aurora from pausing. |
| Aurora Serverless v2 | ACU-hours between min and max, storage, backups | Staging can scale to 0 after an hour idle. Prod has a floor of 0.5 ACU on 2 instances. |
| Fargate services | vCPU and memory × tasks × hours | Staging runs about 3.5 vCPU and 7 GB at the default sizes; prod doubles the task count and autoscales. |
| Load balancer | Hours plus traffic | One ALB per env. |
| Interface endpoints | 3 endpoints × 2 AZs, hourly | For the sandbox tier. `enable_interface_endpoints = false` removes them while no workspaces run. |
| CloudWatch | Log ingestion, Container Insights, alarms, flow logs in prod | Grows with traffic and log verbosity. Without ClickHouse the collector logs one line per batch of telemetry. |
| Secrets Manager | About 12 secrets, plus 2 for each sign-in provider | Small and fixed. |
| Builder workspaces | 2 vCPU and 4 GB (8 GB in prod) per running workspace, EFS storage | Zero until workspaces are launched. |
| Per-app Lambda and Step Functions | Requests and duration | Zero until apps are deployed. |
| Cloudflare | Workers and KV usage; the managed WAF in prod needs a paid plan | |
| ClickHouse Cloud | Only with `enable_clickhouse = true` (prod example: 16 to 64 GB replicas) | Likely the largest fixed line in prod. |
| Model providers | Tokens through the LLM gateway | Not infrastructure, and the least bounded. Set budgets in LiteLLM before opening an env to users. |

An idle staging env is mostly NAT, RDS Proxy, the ALB, the endpoints and the Fargate tasks. To park it cheaply, set every service's desired count to 0 and turn the endpoints off.

## What was verified

Without an AWS or Cloudflare account, on a developer machine and in CI:

- **Terraform.** `fmt -check`, `validate`, and `terraform test` for both envs. The test ([`tests/wiring.tftest.hcl`](../infra/terraform/envs/staging/tests/wiring.tftest.hcl)) plans the whole env against mock providers, with ClickHouse off and on, and checks that each service is given the settings its code reads.
- **Images.** The seven images of the first services build for `linux/amd64` and run together the way Terraform configures them: the `db-bootstrap` script against Postgres 17, the control DB migration and every service logging in as `kelay_platform`, LiteLLM as `kelay_litellm`, each service's health route, and the Data API, the MCP gateway and Kelay ID reading apps from the control API.
- **The Builder image.** Built for the machine it was checked on (`linux/arm64`, not the `linux/amd64` the script pushes) and run by [`services/builder/scripts/verify-image.ts`](../services/builder/scripts/verify-image.ts) with a control API stub and the scripted agent. As the workspace task: a turn driven over the runtime protocol, the bundles built in the container, fetched and stored, the deploy received by the stub, and the web bundle answering `GET /<handle>/<app>` with 200 in the Lambda runtime emulator image (`public.ecr.aws/lambda/nodejs:22`). As the Builder service: a build over its HTTP API, and the app's `next dev` through the preview proxy (the page, a script, the HMR WebSocket).
- **App bundles.** The test suite builds the scripted Ticket Board app with OpenNext and calls the handlers of `web.zip` and `nodes.zip` in a process of their own.
- **Code.** Unit tests of the registry sources, of each service on the control API source, of the database creation on first deploy, of the `aws` deploy driver, the `fargate` workspace driver and the S3 artifact store against a mocked AWS SDK, of the Cloudflare KV route store against a mocked Cloudflare API, and of the preview proxy against a fake dev server; the e2e suite, which runs the control API registry.

Not verified, because it needs the real services:

- the IAM policies of the Deploy role against real Lambda and Step Functions calls, and of the Builder role against real ECS, EFS and S3 calls;
- a workspace task on Fargate: its EFS access point, the security group rules between the Builder and the task, and the Builder reaching it over the VPC;
- an app function created from a real bundle in S3, behind its function URL and the Router Worker, and a graph run on Step Functions;
- a write to Workers KV with a real token, and the Router reading it;
- a dev preview through Cloudflare and the load balancer, WebSocket included;
- RDS Proxy with the two logins, TLS from the services to the proxy (`sslmode=verify-full`), the Cloudflare rules, and the ClickHouse exporter against ClickHouse Cloud.

## What is still open

1. **The first builder.** The code is there: the console signs builders in through Kelay ID, and Kelay ID makes a person a builder when they sign up with an email on `KELAY_BUILDER_ALLOWLIST` (contracts §8). Terraform does not pass the settings yet. `identity` needs `KELAY_BUILDER_ALLOWLIST` (or `KELAY_OPEN_SIGNUP=true`) and `KELAY_ID_COOKIE_DOMAIN=<zone>`, so that the session cookie of `id.<zone>` also reaches `console.<zone>`; `console` needs `KELAY_ID_ISSUER` and `CONSOLE_URL`. An allowlisted email counts only when a sign-in provider verified it, so the first builder signs up with one of `identity_social_providers`. None of this has run against a deployed environment.
2. **The Builder keeps its state on its own task.** The transcripts and the per-app state (which commit is deployed, the dev caller token) are files on the task's disk, and the workspaces it has open are in its memory. A new Builder task (a deploy, a crash) finds the workspace tasks and the repos on EFS again, but it has lost the transcripts and deploys the next turn of every app as if for the first time. The service therefore runs as one task. Moving that state to the control DB or S3 comes before more than a handful of builders use an env.
3. **Dev previews share one host.** Every preview is `https://preview.<zone>/preview/<app>/`, so the previews of one builder's apps share an origin. One host per app (`BUILDER_PREVIEW_DOMAIN`, `<app>.preview.<zone>`) needs a wildcard DNS record, a certificate for `*.preview.<zone>` on Cloudflare and on the load balancer, and a listener rule for it; none of that is in Terraform.
4. **Data in a deployed dev preview.** A preview trades the browser's Kelay ID session for the person's token ([`services/builder`](../services/builder/README.md), "Data in the dev preview"). That works on one machine. In a deployed env two things are missing: Kelay ID's session cookie has to reach `preview.<zone>` (`KELAY_ID_COOKIE_DOMAIN`, see 1); the workspace task gets `KELAY_ID_ISSUER`, the public host, and the sandbox tier has no route to it, so the token call needs Kelay ID's private address and its port in the sandbox security group.
5. **The gateway key.** `llm-gateway-key` has to be a key LiteLLM accepts. Create a virtual key with the master key once the gateway runs ([`infra/litellm/README.md`](../infra/litellm/README.md)), store it with `set-secrets.sh --only llm-gateway-key`, and restart `control-api` and `builder`. Every Builder workspace calls models with this same key; a key per app, with its own budget, is not there yet.
6. **Rate limits in Kelay ID** are kept in each task's memory, so with several tasks the effective limit is multiplied. The client IP comes from `cf-connecting-ip` (`KELAY_ID_CLIENT_IP_HEADER`), which is only trustworthy while `restrict_alb_to_cloudflare = true`.
7. **Forgejo** is not provisioned, and nothing reads a Forgejo setting yet.
