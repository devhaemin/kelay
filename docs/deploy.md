# First deploy

How to bring up one Kelay environment (`staging` first, then `prod`) from an empty AWS account and an empty Cloudflare zone. It is written for the person who runs the commands.

> **Nothing here has been run against a real account.** The commands come from the Terraform in [`infra/terraform`](../infra/terraform/README.md), the service code and dry runs of the scripts in [`infra/deploy`](../infra/deploy). Treat the first staging deploy as the test of this document, and correct it where it is wrong.

Read [Known gaps](#known-gaps) before you start. After this runbook the base infrastructure exists and two services answer (`control-api`, `llm-gateway`). Kelay ID, the Data API and the MCP gateway need the app registry gap closed before they start.

## What you need

| Thing | Detail |
|---|---|
| AWS account | One per environment. Credentials that can create everything in `infra/terraform` (admin-equivalent). |
| Cloudflare zone | One per environment, on your account. An API token with: Zone DNS edit, Zone Settings edit, Zone WAF edit, Workers Routes edit, Workers Scripts edit, Workers KV Storage edit. |
| ACM certificate | In `ap-northeast-2`, for `*.<zone>` and `<zone>`, validated through DNS in Cloudflare. |
| Tools | Terraform 1.17.2, AWS CLI v2, Docker, Node 22, pnpm 10.4.1, `jq`. `wrangler` comes with `pnpm install`. |
| Provider keys | An Anthropic API key. OAuth client ids and secrets for the sign-in providers you want (Google, Kakao, GitHub). |

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

Sizes and counts of the services live in [`infra/deploy/services/<env>.json`](../infra/deploy/services). `console`, `preview-proxy` and `otel-collector` are at zero there because no image exists for them yet.

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

Read the plan before applying. A first apply takes 20 to 40 minutes, most of it Aurora and the RDS Proxy. The ECS services are created now and cannot start yet: their images and secrets come next. That is expected.

### 4. Secrets

```sh
cp infra/deploy/secrets.env.example infra/deploy/secrets.$ENV.env     # ignored by git
```

Fill it in. The file explains each value. Two need Terraform outputs:

```sh
terraform output -raw db_proxy_endpoint
aws secretsmanager get-secret-value --secret-id "$(terraform output -raw db_master_secret_arn)" --query SecretString --output text
```

`control-database-url` is `postgres://<username>:<password>@<proxy endpoint>:5432/kelay_control?sslmode=require`. URL-encode the password.

```sh
infra/deploy/set-secrets.sh --env $ENV --file infra/deploy/secrets.$ENV.env            # shows names and lengths only
infra/deploy/set-secrets.sh --env $ENV --file infra/deploy/secrets.$ENV.env --execute
```

ECS cannot start a task while any secret it references is empty. Give every secret a value, `unused` for the ones you do not have.

### 5. The LiteLLM database

The LLM gateway keeps its keys and spend logs in a database named `litellm` on the same cluster. Terraform creates only `kelay_control`. Create `litellm` with a Postgres client that can reach the RDS Proxy, which means from inside the VPC. One way is a one-off Fargate task that reuses `control-api`'s execution role and its `control-database-url` secret:

```sh
NET=$(aws ecs describe-services --cluster kelay-$ENV --services control-api --query 'services[0].networkConfiguration' --output json)
EXEC_ROLE=arn:aws:iam::$AWS_ACCOUNT_ID:role/kelay-$ENV-control-api-exec
SECRET=$(terraform output -json secret_arns | jq -r '."control-database-url"')
aws ecs register-task-definition --family kelay-$ENV-psql --requires-compatibilities FARGATE --network-mode awsvpc \
  --cpu 256 --memory 512 --execution-role-arn $EXEC_ROLE --container-definitions "[{
    \"name\": \"psql\", \"image\": \"public.ecr.aws/docker/library/postgres:17\",
    \"secrets\": [{\"name\": \"DATABASE_URL\", \"valueFrom\": \"$SECRET\"}],
    \"command\": [\"sh\", \"-c\", \"psql \\\"\$DATABASE_URL\\\" -c 'create database litellm'\"]}]"
aws ecs run-task --cluster kelay-$ENV --launch-type FARGATE --task-definition kelay-$ENV-psql --network-configuration "$NET"
```

Check that the task exits with code 0 (`aws ecs describe-tasks`), then deregister the task definition.

### 6. Images

```sh
infra/deploy/build-images.sh --env $ENV --account $AWS_ACCOUNT_ID --push            # read it
infra/deploy/build-images.sh --env $ENV --account $AWS_ACCOUNT_ID --push --execute
```

It builds `control-api`, `data-api`, `identity`, `mcp-gateway` and `llm-gateway` for `linux/amd64` and pushes them as `kelay-$ENV/<service>:$TAG`. The repositories are tag-immutable; a tag that is already there is skipped. The tag must be the one from step 3. If you committed since, render and apply again with the new tag.

### 7. Migrate the control DB

`control-api` does not migrate on start. Run its migration as a one-off task:

```sh
aws ecs run-task --cluster kelay-$ENV --launch-type FARGATE --task-definition kelay-$ENV-control-api \
  --network-configuration "$NET" \
  --overrides '{"containerOverrides":[{"name":"control-api","command":["node","dist/migrate.js"]}]}'
```

It logs `migrations applied` to `/kelay/$ENV/control-api`. Kelay ID creates its own tables when it starts.

### 8. Start the services

ECS retries on its own, but slowly. Force it:

```sh
for s in control-api llm-gateway identity data-api mcp-gateway; do
  aws ecs update-service --cluster kelay-$ENV --service $s --force-new-deployment --query service.serviceName
done
```

### 9. Router

Terraform deployed the Worker in step 3. Give it the AWS key it signs Lambda calls with:

```sh
aws iam create-access-key --user-name kelay-$ENV-router
pnpm --filter @kelay/router exec wrangler secret put AWS_ACCESS_KEY_ID --name kelay-$ENV-router
pnpm --filter @kelay/router exec wrangler secret put AWS_SECRET_ACCESS_KEY --name kelay-$ENV-router
```

Then deploy it once with wrangler. This adds `CONTROL_ORIGIN`, which the Terraform bindings do not set and the Router needs for store pages:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
terraform -chdir=infra/terraform/envs/$ENV output -json > infra/deploy/out/$ENV/tf-outputs.json
node infra/deploy/render-router-config.mjs --env $ENV --outputs infra/deploy/out/$ENV/tf-outputs.json --out infra/deploy/out/$ENV/wrangler.json
pnpm --filter @kelay/router exec wrangler deploy --config "$PWD/infra/deploy/out/$ENV/wrangler.json" --dry-run
pnpm --filter @kelay/router exec wrangler deploy --config "$PWD/infra/deploy/out/$ENV/wrangler.json"
```

Routes for apps go into Workers KV. Nothing writes them automatically yet:

```sh
infra/deploy/upload-routes.sh --namespace-id "$(terraform -chdir=infra/terraform/envs/$ENV output -raw routes_kv_namespace_id)" \
  --file infra/deploy/out/$ENV/routes.json            # same shape as infra/deploy/routes.example.json; add --execute
```

## Verification

| Check | Expected |
|---|---|
| `aws ecs describe-services --cluster kelay-$ENV --services control-api llm-gateway --query 'services[].[serviceName,runningCount,desiredCount]'` | Running equals desired. |
| `curl -s https://api.<zone>/healthz` | `{"ok":true,"service":"control-api","db":"ok",...}` |
| `curl -s https://llm.<zone>/health/liveliness` | `200` |
| `curl -s -o /dev/null -w '%{http_code}' https://api.<zone>/internal/v1/apps/x` | `403` from Cloudflare: internal routes are blocked at the edge. |
| `curl -s https://<app host>/nobody/nothing` | JSON `unknown_app` from the Router. |
| `curl -s https://id.<zone>/healthz`, `https://id.<zone>/.well-known/oauth-authorization-server` | `{"ok":true}` and metadata whose `issuer` is `https://id.<zone>`, once Kelay ID runs. |
| CloudWatch alarms of `kelay-$ENV` | `OK` or `INSUFFICIENT_DATA`, none in `ALARM`. |

When a service does not come up, read its stopped task first: `aws ecs describe-tasks` shows `stoppedReason` (a missing image or an empty secret appears here, not in the logs). Then the log group `/kelay/$ENV/<service>`.

## Rollback

- **A bad image.** ECS rolls a failed deployment back by itself (circuit breaker). To go back on purpose, render the var file with the previous tag (`--tag <old>`, or `--set <service>=<old>` for one service), plan and apply. Old tags stay in ECR; the last 50 images are kept.
- **A bad Terraform change.** Check out the previous commit, plan, read it, apply. Do not edit state by hand.
- **A bad control DB migration.** Migrations only go forward. Restore the cluster to a point in time (`aws rds restore-db-cluster-to-point-in-time`) into a new cluster and repoint, or write a forward fix. Take a snapshot before step 7 on any environment that holds data.
- **The Router.** `pnpm --filter @kelay/router exec wrangler rollback --name kelay-$ENV-router` returns to the previous version.
- **A route.** Upload the old value again, or delete the key (see `upload-routes.sh`).
- **Everything (staging only).** `terraform destroy` works while `deletion_protection = false`. Secrets stay recoverable for 7 days, which blocks an immediate re-create under the same names.

## Later deploys with GitHub Actions

[`ci.yml`](../.github/workflows/ci.yml) runs on pull requests and on `main`: typecheck, unit tests, e2e, `terraform fmt` and `validate` for both envs, workflow and script lint, and a build of every image with no push. It needs no secrets.

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
| Fargate services | vCPU and memory × tasks × hours | Staging runs about 2.5 vCPU and 5 GB at the default sizes; prod doubles the task count and autoscales. |
| Load balancer | Hours plus traffic | One ALB per env. |
| Interface endpoints | 3 endpoints × 2 AZs, hourly | For the sandbox tier. `enable_interface_endpoints = false` removes them while no workspaces run. |
| CloudWatch | Log ingestion, Container Insights, alarms, flow logs in prod | Grows with traffic and log verbosity. |
| Secrets Manager | About 17 secrets | Small and fixed. |
| Builder workspaces | 2 vCPU and 4 GB (8 GB in prod) per running workspace, EFS storage | Zero until workspaces are launched. |
| Per-app Lambda and Step Functions | Requests and duration | Zero until apps are deployed. |
| Cloudflare | Workers and KV usage; the managed WAF in prod needs a paid plan | |
| ClickHouse Cloud | Only with `enable_clickhouse = true` (prod example: 16 to 64 GB replicas) | Likely the largest fixed line in prod. |
| Model providers | Tokens through the LLM gateway | Not infrastructure, and the least bounded. Set budgets in LiteLLM before opening an env to users. |

An idle staging env is mostly NAT, RDS Proxy, the ALB, the endpoints and the Fargate tasks. To park it cheaply, set every service's desired count to 0 and turn the endpoints off.

## Known gaps

These were found while preparing the deploy. Each one is outside what the deploy scripts can fix.

1. **App registry.** `identity`, `data-api` and `mcp-gateway` require `KELAY_APPS_FILE`, a file inside the container that includes database URLs. The images contain none and Terraform mounts none, so these three services exit on start. They need to read apps from the control API (`GET /internal/v1/apps/:app` exists) or the control DB.
2. **No image for `console`, `preview-proxy`, `otel-collector` or the builder `workspace`.** The first three are held at zero tasks. Once an image exists, add it to `infra/deploy/images.json`, raise the count in `services/<env>.json`, and after the first apply change counts with `aws ecs update-service --desired-count` (Terraform sets the count only at creation).
3. **Kelay ID's environment.** Terraform gives it the provider client secrets and not the client ids (`GOOGLE_CLIENT_ID` and so on), and a production build turns email sign-in off unless `KELAY_ID_EMAIL_PASSWORD=true`. As configured, nobody can sign in. It also needs `KELAY_CALLER_SECRET` (to record consents in the control API; a production build refuses to start without it) and `KELAY_ID_CORS_ORIGINS`. Plain values can be set through `"identity": { "env": { ... } }` in `services/<env>.json`; that replaces the service's `env` block in `main.tf`, so repeat `BETTER_AUTH_URL`. The caller secret has to be added to the service's `secrets` in `main.tf`.
4. **The `aws` deploy driver.** `control-api` reads `KELAY_DEPLOY_DRIVER=aws`, `KELAY_LAMBDA_ROLE_ARN` and `KELAY_SFN_ROLE_ARN`. Terraform sets `LAMBDA_EXEC_ROLE_ARN` and `STATES_EXEC_ROLE_ARN`, so the service starts with the `local` driver. The driver also tags functions `kelay:env=dev|prod` and can call `lambda:AddPermission`, while the Deploy role requires `kelay:env=<platform env>` and `kelay:managed-by=kelay-deploy` and denies `AddPermission`. Publishing an app to Lambda will be refused until the two agree. Leave `KELAY_ROUTER_PRINCIPAL` unset.
5. **App databases and routes.** No `APP_DATABASE_URL_TEMPLATE` is set (it would hold a password), so an app env gets its database through `PUT /internal/v1/apps/:app/envs/:env`. The control API does not write KV routes; use `upload-routes.sh`.
6. **Router bindings.** `router_vars` in `main.tf` lacks `CONTROL_ORIGIN`. Until it is added, a `terraform apply` that changes the Worker removes it; run the Router deploy afterwards.
7. **Master password rotation.** The database URLs in Secrets Manager embed the Aurora master password. RDS rotates a managed master password on a schedule (seven days unless configured otherwise), after which those URLs stop working. Before relying on an env, either manage the rotation and update the two secrets with it, or give the services their own database users and matching RDS Proxy auth entries.
8. **Rate limits in Kelay ID** are kept in each task's memory, so with several tasks the effective limit is multiplied. The client IP comes from `cf-connecting-ip` (`KELAY_ID_CLIENT_IP_HEADER`), which is only trustworthy while `restrict_alb_to_cloudflare = true`.
