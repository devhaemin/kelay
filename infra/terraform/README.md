# Kelay infrastructure as code

Terraform for the platform base described in [`docs/infrastructure.md`](../../docs/infrastructure.md): one AWS region (`ap-northeast-2`, Seoul), with Cloudflare at the edge.

- **What Terraform owns:** the network, data stores, platform services, sandboxes, edge and alarms.
- **What it does not own:** per-app Lambda functions and Step Functions state machines. The Deploy service creates those at runtime. Terraform provides the IAM guardrails it works within (see the last section).

| Tool | Version |
|---|---|
| Terraform | `>= 1.11` (S3 native locking); verified with 1.17.2 |
| hashicorp/aws | `~> 6.72` |
| cloudflare/cloudflare | `~> 5.28` (the v5 schema; v4 resources such as `cloudflare_record` do not exist) |
| hashicorp/random | `~> 3.9` |
| ClickHouse/clickhouse | `~> 3.43`, used only when `enable_clickhouse = true` |

The community modules come from [terraform-aws-modules](https://github.com/terraform-aws-modules): `vpc`, `rds-aurora`, `rds-proxy`, `efs`, `s3-bucket`, `alb`, `ecs` and `ecr`.

## Layout

```
infra/terraform/
  modules/
    network/        VPC across 2 AZs; subnet tiers public | platform | sandbox | data; NAT; S3 gateway endpoint;
                    interface endpoints for the sandbox tier; optional flow logs
    data/           Aurora PostgreSQL Serverless v2 (RDS-managed master secret, scale to 0), RDS Proxy,
                    the service database logins and the db-bootstrap task that creates them,
                    EFS for workspaces (mounts only through access points), S3 app-files and artifacts
    platform/       ECS cluster, HTTPS ALB with host/path rules, one Fargate service per entry of the
                    `services` map, ECR repos, log groups, task roles, Cloud Map private DNS, secret shells
    runtime/        IAM for per-app resources: kelay-app-boundary, shared Lambda and Step Functions roles,
                    the Deploy service role, the run orchestrator policy, and the Cloudflare Router user
    sandboxes/      Separate ECS cluster, builder workspace task definition (EFS, IAM auth),
                    restricted-egress security group, and the launcher policy for the Control API
    edge/           Cloudflare: zone lookup, DNS, ROUTES KV, Router Worker script and route,
                    strict TLS zone settings, MCP rate limit, custom firewall rule, optional managed WAF
    observability/  SNS alarm topic, CloudWatch alarms (ALB 5xx, ECS CPU, Aurora ACUs), optional ClickHouse Cloud
  envs/
    staging/        Root module for staging
    prod/           Root module for prod
```

### Env roots

`main.tf`, `variables.tf`, `outputs.tf`, `providers.tf` and `tests/wiring.tftest.hcl` are identical in `envs/staging` and `envs/prod`; keep them that way (`diff envs/staging/main.tf envs/prod/main.tf` should print nothing). An env differs only in:

- `env.tf`: the env name;
- the backend `key` in `versions.tf`;
- `terraform.tfvars`, copied from `terraform.tfvars.example`.

### Network tiers

| Tier | Subnets (/16 → per AZ) | Default route | Holds |
|---|---|---|---|
| public | `/24` | internet gateway | ALB, NAT gateways |
| platform | `/20` | NAT | Fargate platform services (they call Anthropic, OpenAI and Gemini) |
| sandbox | `/20` | none | Builder workspaces; they reach AWS only through endpoints |
| data | `/24` | none | Aurora, RDS Proxy, EFS mount targets |

Builder code is untrusted ([infrastructure §3](../../docs/infrastructure.md)). Its security group allows only these destinations:

- NFS to EFS;
- HTTPS to interface endpoints and S3 (image layers);
- the platform ports listed in `platform_ports` (the LLM gateway).

Workspaces carry no secrets and have no internet route. The preview proxy reaches `next dev` on port 3000.

### Platform services

The env roots define the eight services with ports from [contracts §11](../../docs/contracts.md):

| Service | Port | Public host |
|---|---|---|
| console | 3000 | `console.<zone>` |
| control-api (also runs the Deploy service) | 4003 | `api.<zone>` |
| identity (Kelay ID) | 4001 | `id.<zone>` |
| data-api | 4002 | `data.<zone>` |
| mcp-gateway | 4004 | `mcp.<zone>` |
| llm-gateway (LiteLLM) | 4000 | `llm.<zone>` |
| preview-proxy (held at zero tasks: nothing implements it yet) | 4005 | `preview.<zone>` |
| otel-collector | 4318 (health 13133) | `otel.<zone>` |

Each service is also reachable in the VPC at `http://<service>.<env>.kelay.internal:<port>`; services call each other this way. The public hosts exist for callers outside the VPC (browsers, the per-app Lambdas, users' AI assistants). They are proxied by Cloudflare, and the ALB only accepts Cloudflare's IP ranges (`restrict_alb_to_cloudflare`). A Cloudflare rule blocks `/internal/*` paths at the edge.

The ALB health-checks Kelay services at `GET /healthz`, LiteLLM at `/health/liveliness`, and the OTel collector's `health_check` extension at port 13133. Size and image overrides go in `service_overrides`; its `env` entries are added to a service's own settings. Every service image is `<account>.dkr.ecr.ap-northeast-2.amazonaws.com/kelay-<env>/<service>:<image_tag>`, built from the Dockerfiles listed in [`infra/deploy/images.json`](../deploy/images.json): the `llm-gateway` image from [`infra/litellm`](../litellm) and the `otel-collector` image from [`infra/otel`](../otel). Repositories are tag-immutable, so push a new tag (for example the git SHA) and set `image_tag`.

### What the services are given

`main.tf` passes each service the settings its code reads, and the `wiring` test checks them:

- **Every service:** `KELAY_ENV`, the platform URLs, and `KELAY_APPS_SOURCE=control-api`, so Kelay ID, the Data API and the MCP gateway read apps from the control API ([contracts §6](../../docs/contracts.md)) instead of a file.
- **Database access:** `CONTROL_DATABASE_URL` and `APP_DATABASE_URL_TEMPLATE` are plain settings without a login. `DB_USER` and `DB_PASSWORD` come from the `db-platform` secret; the LLM gateway gets `DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_USERNAME` and `DATABASE_PASSWORD` from `db-litellm`. No service has the Aurora master login, which RDS rotates.
- **control-api:** `KELAY_DEPLOY_DRIVER=aws` with `KELAY_LAMBDA_ROLE_ARN`, `KELAY_SFN_ROLE_ARN` and `APP_RESOURCE_PREFIX`, and `APP_RUNTIME_*` with the public hosts that app functions call. `KELAY_ROUTER_PRINCIPAL` is left unset on purpose (see the last section).
- **identity:** `KELAY_ID_CORS_ORIGINS` (the console), `KELAY_ID_EMAIL_PASSWORD` from `identity_email_password`, and a client id and client secret for each provider in `identity_social_providers`.
- **otel-collector:** with `enable_clickhouse` it exports to ClickHouse (`CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_PASSWORD`); without, it runs the image's log-only pipeline.
- **Router Worker:** `MCP_ORIGIN`, `CONTROL_ORIGIN` and `AWS_REGION`, beside the `ROUTES` namespace and the AWS key.

## Bootstrap (once per AWS account)

Use one AWS account per environment. All per-app resource names share the `kelay-app-` prefix, so a separate account is what keeps the staging Deploy service away from production functions. If both envs must share an account, set a distinct `app_resource_prefix` per env in the runtime module, for example `kelay-app-stg-`.

1. **Create the state bucket.** The S3 backend uses native lock files (`use_lockfile = true`), so no DynamoDB table is needed.

   ```sh
   ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
   BUCKET=kelay-tfstate-$ACCOUNT
   aws s3api create-bucket --bucket "$BUCKET" --region ap-northeast-2 \
     --create-bucket-configuration LocationConstraint=ap-northeast-2
   aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
   aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
     '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
   aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
     BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   ```

2. **Request an ACM certificate** in `ap-northeast-2` for `*.<zone>` and `<zone>`, validated through DNS in Cloudflare. Cloudflare connects to the ALB with Full (strict) TLS, so the ALB needs a valid certificate.

3. **Create a Cloudflare API token** scoped to the zone (DNS edit, Zone Settings edit, Zone WAF edit, Workers Routes edit) and the account (Workers Scripts edit, Workers KV Storage edit). Use one Cloudflare zone per env. Zone settings and zone rulesets have a single owner, so if two envs share a zone, set `manage_zone_settings` and `manage_zone_rulesets` to `false` in one of them.

4. **Build the Router Worker bundle** that `router_bundle_path` points at (`services/router/dist/index.js` by default): `pnpm --filter @kelay/router build`. The Worker script resource uploads that one ES module file.

5. **Configure the env root:**

   ```sh
   cd infra/terraform/envs/staging
   cp backend.hcl.example backend.hcl            # set the bucket
   cp terraform.tfvars.example terraform.tfvars  # set account, zone, certificate, image_tag
   terraform init -backend-config=backend.hcl
   ```

## Plan and apply

Credentials come only from the environment. Nothing secret goes in `.tf` or `.tfvars` files.

| Provider | Credentials |
|---|---|
| AWS | An assumed role (GitHub OIDC in CI, `aws sso login` locally). `aws_account_id` makes Terraform refuse any other account. |
| Cloudflare | `CLOUDFLARE_API_TOKEN` |
| ClickHouse Cloud (only with `enable_clickhouse = true`) | `CLICKHOUSE_ORG_ID`, `CLICKHOUSE_CLOUD_API_KEY` and `CLICKHOUSE_CLOUD_API_SECRET`. When the flag is off, the provider gets placeholders, because Terraform configures it even with nothing to manage. |

```sh
terraform plan -out=tfplan
terraform apply tfplan
```

### Suggested CI: GitHub Actions with OIDC

1. Create an IAM OIDC provider for `token.actions.githubusercontent.com` in each account.
2. Create a role `kelay-terraform-<env>` that trusts it, with the condition `token.actions.githubusercontent.com:sub` equal to `repo:devhaemin/kelay:environment:<env>`.
3. Give that role the permissions Terraform needs (admin-equivalent minus IAM user and Organizations actions, or a curated policy).
4. Run `fmt -check` and `validate` on every pull request, plus `plan` for each env, posted as a PR comment.
5. Run `apply` of the reviewed plan only from `main`, through a GitHub Environment with required reviewers for `prod`.
6. Keep `CLOUDFLARE_API_TOKEN` as an environment secret.

```yaml
permissions: { id-token: write, contents: read }
steps:
  - uses: actions/checkout@v5
  - uses: aws-actions/configure-aws-credentials@v5
    with: { role-to-assume: "arn:aws:iam::<account>:role/kelay-terraform-staging", aws-region: ap-northeast-2 }
  - uses: hashicorp/setup-terraform@v3
    with: { terraform_version: 1.17.2 }
  - run: terraform init -backend-config=backend.hcl && terraform plan -out=tfplan
    working-directory: infra/terraform/envs/staging
```

### Verify without cloud access

From the repository root (the test hashes a file of `services/router`, so the whole repository is mounted):

```sh
docker run --rm -v "$PWD/infra/terraform":/w -w /w hashicorp/terraform:1.17.2 fmt -check -recursive
for env in staging prod; do
  docker run --rm -v "$PWD":/repo -w /repo/infra/terraform/envs/$env --entrypoint sh hashicorp/terraform:1.17.2 \
    -c 'terraform init -backend=false -input=false && terraform validate && terraform test'
done
```

`terraform test` runs [`tests/wiring.tftest.hcl`](envs/staging/tests/wiring.tftest.hcl): it plans the env against mock providers, so it needs no credentials and reaches no account, and it checks the settings each service is given.

The lock files (`envs/*/.terraform.lock.hcl`) are committed with hashes for `linux_amd64`, `linux_arm64`, `darwin_arm64` and `darwin_amd64`. After a provider upgrade, refresh them with `terraform providers lock -platform=...` for those four platforms.

### After the first apply

[`docs/deploy.md`](../../docs/deploy.md) is the runbook, with the commands. In short:

1. **Create the database logins.** Terraform writes the logins of the services to Secrets Manager (`terraform output db_user_secret_arns`) as write-only values, so they never appear in state, and registers them with RDS Proxy. Run the `<name>-db-bootstrap` task (`terraform output db_bootstrap_task_family`) to create the roles and their databases in Postgres. Run it again after raising `db_password_version`.
2. **Fill the secret shells.** Terraform creates the other Secrets Manager secrets empty (`terraform output secret_arns`), and services start only once their secrets have values. Use [`infra/deploy/set-secrets.sh`](../deploy/set-secrets.sh). `clickhouse-password` is the exception: with `enable_clickhouse = true`, Terraform writes it as a write-only value.
3. **Give the Router its AWS key.** Create an access key for the `kelay-<env>-router` user and set it on the Worker:

   ```sh
   wrangler secret put AWS_ACCESS_KEY_ID --name kelay-staging-router
   wrangler secret put AWS_SECRET_ACCESS_KEY --name kelay-staging-router
   ```

   Terraform keeps `secret_text` bindings across uploads. Alternatively, set `create_router_access_key = true` and Terraform manages the key, which puts the secret in state.
4. **Push images.** A service runs once its image tag exists in ECR. `desired_count` sets only the initial count. After that, ECS (and autoscaling where it is configured) owns the count, and Terraform ignores it.

## What the Deploy service creates at runtime

Terraform creates no per-app resources. The Deploy service runs inside `control-api`, under the role `kelay-<env>-deploy`, and creates and updates them on every publish.

| Resource | Name | Notes |
|---|---|---|
| Lambda function per app × env × function (web, agent nodes) | `kelay-app-<app>-<dev\|prod>-*` | Must be tagged `kelay:env=<platform env>`, `kelay:managed-by=kelay-deploy` and `kelay:app=<slug>`; the Deploy service also sets `kelay:app-env=<dev\|prod>`. Runs as the shared `kelay-<env>-app-lambda` role (logs only, under `kelay-app-boundary`). Not attached to a VPC (denied). |
| Lambda versions and aliases | `live` alias per function | Publish moves the alias; rollback moves it back. |
| Function URL | on the alias | `AuthType` must be `AWS_IAM` (other values are denied). Only the Router user may call it, through its own IAM policy: `lambda:InvokeFunctionUrl` plus `lambda:InvokeFunction` when invoked through a function URL. The function gets no resource policy, which is why `KELAY_ROUTER_PRINCIPAL` stays unset. |
| Step Functions state machine per app × env × graph | `kelay-app-*` | Same required tags. Runs as `kelay-<env>-app-states`, which may only invoke `kelay-app-*` functions. Express for runs under 5 minutes, Standard for longer ones. Versions and aliases are published alongside the Lambda alias. |
| Log groups | `/aws/lambda/kelay-app-*`, `/aws/vendedlogs/states/kelay-app-*` | Created with retention by the Deploy service. |
| Build bundles | `s3://<artifacts>/builds/...` | Read by Lambda at deploy time, expired after `build_retention_days`. |
| Route entry | Workers KV `ROUTES`: `/<handle>/<app>` → function URL | Not written by the Control API yet: upload it with `infra/deploy/upload-routes.sh`. |
| Builder workspace | ECS task in `kelay-<env>-sandboxes` | The Control API creates an EFS access point per workspace and registers a `kelay-<env>-workspace*` task definition revision with it. RunTask cannot override volumes, so a revision is the only way to attach the access point. The revision may only use the two sandbox roles. |
| App databases | `app_<app>_dev`, `app_<app>_prod` on the Aurora cluster | Created by the Control API through RDS Proxy the first time a version is deployed to the env, as the `kelay_platform` login, following contracts §3. |

Guardrails enforced in IAM:

- **Tagged resources only.** The Deploy service can create a function or a state machine only with the required tags, and change only ones that carry them. Reads (`Get*`, `Describe*`, `List*`) are limited by the name prefix alone, so that it can tell a resource that does not exist from one it may not touch.
- **Protected tags.** The Deploy service cannot remove or change the required tags.
- **Execution roles.** It can only pass the two shared roles.
- **Fixed limits.** It cannot add resource policies to functions, attach them to a VPC, or touch the permissions boundary.
- **Per-app roles.** With `allow_per_app_roles = true` it may create `kelay-app-*` roles, but only with `kelay-app-boundary` attached.

Agent-graph runs are started by the run orchestrator policy, attached to the same role.

## Open items

- **Forgejo** is not provisioned here, and no service reads a Forgejo setting yet.
- **The builder service** will need the sandbox settings (`terraform output sandbox`), the workspace image and the `preview-proxy` service; none of them is wired to a task today.
- **ALB access logs** are off. They need a log bucket with the ELB delivery policy.
- **Platform services share one task security group**, and each gets its own IAM role. The control API, Kelay ID and the Data API share one Postgres login (`kelay_platform`); the control API and the Data API have to, because the control API's migration grants `kelay_runtime` to the login the Data API uses. Giving Kelay ID its own is a follow-up.
