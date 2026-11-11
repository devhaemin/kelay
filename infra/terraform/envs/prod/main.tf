# Identical in every env; per-env values come from env.tf and tfvars.

locals {
  name = "kelay-${local.env}"
  tags = { "kelay:env" = local.env }

  hosts = { for k, label in var.host_labels : k => "${label}.${var.zone_name}" }

  # Ports follow docs/contracts.md §11. Internal URLs are known up front so services can be wired
  # to each other without depending on module outputs.
  ports = {
    "llm-gateway"    = 4000
    "identity"       = 4001
    "data-api"       = 4002
    "control-api"    = 4003
    "mcp-gateway"    = 4004
    "builder"        = 4006
    "console"        = 3000
    "otel-collector" = 4318
  }
  internal_domain = "${local.env}.kelay.internal"
  internal_url    = { for svc, port in local.ports : svc => "http://${svc}.${local.internal_domain}:${port}" }

  # Secrets Manager shells whose values are set out of band (infra/deploy/set-secrets.sh). Terraform
  # never writes them, clickhouse-password excepted (write-only). The database logins are not here:
  # the data module creates and fills those.
  secret_names = concat(
    [
      "kelay-caller-secret",
      "better-auth-secret",
      "llm-gateway-key",
      "litellm-master-key",
      "litellm-salt-key",
      "anthropic-api-key",
      "openai-api-key",
      "gemini-api-key",
      "clickhouse-password",
      # A Cloudflare API token with Workers KV Storage: Edit, for the control API's route table writes.
      "cloudflare-kv-token",
    ],
    flatten([for p in var.identity_social_providers : ["${p}-client-id", "${p}-client-secret"]]),
  )

  # Database URLs carry no login. Each service adds its own from DB_USER and DB_PASSWORD, which come
  # from a login secret of the data module, so no URL has to change when a password does.
  db_host             = module.data.proxy_endpoint
  control_db_url      = "postgres://${local.db_host}:5432/${module.data.database_name}?sslmode=verify-full"
  app_db_url_template = "postgres://${local.db_host}:5432/app_{app}_{env}?sslmode=verify-full"
  platform_db_login = {
    DB_USER     = "${module.data.db_user_secret_arns["platform"]}:username::"
    DB_PASSWORD = "${module.data.db_user_secret_arns["platform"]}:password::"
  }

  # Every name here is one a service reads; see each service's server.ts.
  shared_env = {
    KELAY_ENV                   = local.env
    AWS_REGION                  = var.region
    KELAY_ID_ISSUER             = "https://${local.hosts.id}"
    KELAY_ID_JWKS_URL           = "${local.internal_url["identity"]}/api/auth/jwks"
    DATA_API_URL                = local.internal_url["data-api"]
    CONTROL_API_URL             = local.internal_url["control-api"]
    LLM_GATEWAY_URL             = local.internal_url["llm-gateway"]
    MCP_PUBLIC_BASE_URL         = "https://${var.app_hostname}"
    OTEL_EXPORTER_OTLP_ENDPOINT = local.internal_url["otel-collector"]
    # Apps come from the control API (docs/contracts.md §6), not from a file in the image.
    KELAY_APPS_SOURCE = "control-api"
  }

  base_services = {
    console = {
      port         = local.ports["console"]
      cpu          = 512
      memory       = 1024
      host_headers = [local.hosts.console]
      priority     = 10
      env = {
        CONSOLE_DATA     = "http"
        KELAY_APP_ORIGIN = "https://${var.app_hostname}"
        BUILDER_URL      = local.internal_url["builder"]
      }
    }

    control-api = {
      port         = local.ports["control-api"]
      cpu          = 512
      memory       = 1024
      host_headers = [local.hosts.api]
      priority     = 20
      env = {
        CONTROL_DATABASE_URL      = local.control_db_url
        APP_DATABASE_URL_TEMPLATE = local.app_db_url_template

        # The Deploy service: per-app Lambda functions and state machines under the runtime module's IAM.
        # KELAY_ROUTER_PRINCIPAL stays unset: the Router's IAM user is in this account, so its own
        # policy lets it call function URLs, and the Deploy role may not add resource policies.
        KELAY_DEPLOY_DRIVER   = "aws"
        KELAY_LAMBDA_ROLE_ARN = module.runtime.lambda_exec_role_arn
        KELAY_SFN_ROLE_ARN    = module.runtime.states_exec_role_arn
        APP_RESOURCE_PREFIX   = module.runtime.app_resource_prefix

        # App functions run outside the VPC and reach the platform through its public hosts.
        APP_RUNTIME_DATA_API_URL    = "https://${local.hosts.data}"
        APP_RUNTIME_CONTROL_API_URL = "https://${local.hosts.api}"
        APP_RUNTIME_LLM_GATEWAY_URL = "https://${local.hosts.llm}"

        # The Router's route table: the control API writes an app's entry on every deploy and publish.
        ROUTE_STORE            = "cloudflare-kv"
        CLOUDFLARE_ACCOUNT_ID  = var.cloudflare_account_id
        ROUTES_KV_NAMESPACE_ID = module.edge.routes_kv_namespace_id
      }
      secrets = merge(local.platform_db_login, {
        KELAY_CALLER_SECRET  = "kelay-caller-secret"
        LLM_GATEWAY_KEY      = "llm-gateway-key"
        CLOUDFLARE_API_TOKEN = "cloudflare-kv-token"
      })
    }

    identity = {
      port         = local.ports["identity"]
      host_headers = [local.hosts.id]
      priority     = 30
      env = {
        CONTROL_DATABASE_URL    = local.control_db_url
        KELAY_ID_CORS_ORIGINS   = "https://${local.hosts.console}"
        KELAY_ID_EMAIL_PASSWORD = tostring(var.identity_email_password)
      }
      # A sign-in provider is on when both its client id and its client secret are set.
      secrets = merge(
        local.platform_db_login,
        {
          BETTER_AUTH_SECRET  = "better-auth-secret"
          KELAY_CALLER_SECRET = "kelay-caller-secret"
        },
        { for p in var.identity_social_providers : "${upper(p)}_CLIENT_ID" => "${p}-client-id" },
        { for p in var.identity_social_providers : "${upper(p)}_CLIENT_SECRET" => "${p}-client-secret" },
      )
    }

    data-api = {
      port         = local.ports["data-api"]
      cpu          = 512
      memory       = 1024
      host_headers = [local.hosts.data]
      priority     = 40
      secrets = merge(local.platform_db_login, {
        KELAY_CALLER_SECRET = "kelay-caller-secret"
      })
    }

    mcp-gateway = {
      port         = local.ports["mcp-gateway"]
      host_headers = [local.hosts.mcp]
      priority     = 50
      env          = { MCP_RATE_PER_MIN = "60" }
      secrets      = { KELAY_CALLER_SECRET = "kelay-caller-secret" }
    }

    llm-gateway = {
      port         = local.ports["llm-gateway"]
      cpu          = 1024
      memory       = 2048
      host_headers = [local.hosts.llm]
      priority     = 60
      health_path  = "/health/liveliness"
      env = {
        DISABLE_ADMIN_UI  = "True"
        STORE_MODEL_IN_DB = "False"
        OTEL_EXPORTER     = "otlp_http"
        OTEL_ENDPOINT     = "${local.internal_url["otel-collector"]}/v1/traces"
        OTEL_SERVICE_NAME = "llm-gateway"
        # LiteLLM builds its database URL from these four when DATABASE_URL is not set.
        DATABASE_HOST = local.db_host
        DATABASE_NAME = module.data.litellm_database_name
      }
      secrets = {
        LITELLM_MASTER_KEY = "litellm-master-key"
        LITELLM_SALT_KEY   = "litellm-salt-key"
        DATABASE_USERNAME  = "${module.data.db_user_secret_arns["litellm"]}:username::"
        DATABASE_PASSWORD  = "${module.data.db_user_secret_arns["litellm"]}:password::"
        ANTHROPIC_API_KEY  = "anthropic-api-key"
        OPENAI_API_KEY     = "openai-api-key"
        GEMINI_API_KEY     = "gemini-api-key"
      }
    }

    # services/builder: workspaces as tasks of the sandboxes cluster, app bundles in the artifacts
    # bucket, and the preview proxy. The console calls its API over private DNS; the public host is for
    # the dev previews it proxies (https://preview.<zone>/preview/<app>/). It keeps the state of its
    # workspaces in memory and on its own disk, so it runs as one task.
    builder = {
      port         = local.ports["builder"]
      cpu          = 1024
      memory       = 2048
      host_headers = [local.hosts.preview]
      priority     = 70
      # The image's default command is the workspace runtime (services/builder/Dockerfile).
      command = ["node", "--import", "tsx", "src/server.ts"]
      env = {
        BUILDER_WORKSPACE_DRIVER    = "fargate"
        BUILDER_ECS_CLUSTER         = module.sandboxes.cluster_arn
        BUILDER_EFS_FILE_SYSTEM_ID  = module.data.efs_id
        BUILDER_SUBNETS             = join(",", module.sandboxes.subnet_ids)
        BUILDER_SECURITY_GROUPS     = module.sandboxes.security_group_id
        BUILDER_WORKSPACE_IMAGE     = local.workspace_image
        BUILDER_EXECUTION_ROLE_ARN  = module.sandboxes.execution_role_arn
        BUILDER_TASK_ROLE_ARN       = module.sandboxes.task_role_arn
        BUILDER_TASK_FAMILY_PREFIX  = module.sandboxes.task_definition_family
        BUILDER_WORKSPACE_ARCH      = module.sandboxes.cpu_architecture
        BUILDER_WORKSPACE_CPU       = tostring(var.sandbox_cpu)
        BUILDER_WORKSPACE_MEMORY    = tostring(var.sandbox_memory)
        BUILDER_WORKSPACE_LOG_GROUP = module.sandboxes.log_group_name

        BUILDER_PREVIEW_URL_TEMPLATE = "https://${local.hosts.preview}/preview/{app}/"
        BUILDER_ARTIFACT_STORE       = "s3"
        BUILDER_ARTIFACTS_BUCKET     = module.data.artifacts_bucket

        # The coding agent in a workspace calls models through the LLM gateway, with the gateway's key.
        ANTHROPIC_BASE_URL = local.internal_url["llm-gateway"]
      }
      secrets = {
        KELAY_CALLER_SECRET       = "kelay-caller-secret"
        BUILDER_WORKSPACE_API_KEY = "llm-gateway-key"
      }
    }

    # infra/otel: with ClickHouse it exports there; without, it runs the image's log-only pipeline.
    otel-collector = {
      port         = local.ports["otel-collector"]
      cpu          = 512
      memory       = 1024
      host_headers = [local.hosts.otel]
      priority     = 80
      health_path  = "/"
      health_port  = 13133
      command      = var.enable_clickhouse ? null : ["--config=/etc/otelcol-contrib/debug.yaml"]
      env          = { for k, v in { CLICKHOUSE_ENDPOINT = module.observability.clickhouse_native_endpoint } : k => v if var.enable_clickhouse }
      secrets      = { for k, v in { CLICKHOUSE_PASSWORD = "clickhouse-password" } : k => v if var.enable_clickhouse }
    }
  }

  workspace_image = coalesce(var.workspace_image, "${module.platform.ecr_repository_urls["workspace"]}:${var.image_tag}")

  # An override replaces a setting, except env, whose entries are added to the service's own.
  services = {
    for k, s in local.base_services : k => merge(
      s,
      { for attr, value in try(var.service_overrides[k], {}) : attr => value if value != null && attr != "env" },
      # lookup, not try: try gives up on a value that is not fully known yet, and env holds module outputs.
      { env = merge(lookup(s, "env", {}), { for name, value in coalesce(try(var.service_overrides[k].env, null), {}) : name => value }) },
    )
  }
}

module "network" {
  source = "../../modules/network"

  name                       = local.name
  cidr                       = var.vpc_cidr
  single_nat_gateway         = var.single_nat_gateway
  enable_interface_endpoints = var.enable_interface_endpoints
  enable_flow_log            = var.enable_flow_log
  tags                       = local.tags
}

module "data" {
  source = "../../modules/data"

  name                       = local.name
  env                        = local.env
  vpc_id                     = module.network.vpc_id
  data_subnet_ids            = module.network.data_subnet_ids
  database_subnet_group_name = module.network.database_subnet_group_name

  db_client_security_group_ids  = [module.platform.tasks_security_group_id]
  efs_client_security_group_ids = [module.sandboxes.security_group_id]
  efs_client_role_arns          = [module.sandboxes.task_role_arn]

  engine_version      = var.aurora_engine_version
  min_capacity        = var.aurora_min_capacity
  max_capacity        = var.aurora_max_capacity
  instance_count      = var.aurora_instance_count
  deletion_protection = var.deletion_protection
  skip_final_snapshot = !var.deletion_protection
  log_retention_days  = var.log_retention_days
  db_password_version = var.db_password_version

  app_files_cors_origins = ["https://${var.app_hostname}", "https://${local.hosts.console}"]
  force_destroy_buckets  = !var.deletion_protection

  tags = local.tags
}

module "runtime" {
  source = "../../modules/runtime"

  name                     = local.name
  env                      = local.env
  app_resource_prefix      = var.app_resource_prefix
  artifacts_bucket_arn     = module.data.artifacts_bucket_arn
  create_router_access_key = var.create_router_access_key
  tags                     = local.tags
}

module "platform" {
  source = "../../modules/platform"

  name                = local.name
  env                 = local.env
  vpc_id              = module.network.vpc_id
  vpc_cidr_block      = module.network.vpc_cidr_block
  public_subnet_ids   = module.network.public_subnet_ids
  platform_subnet_ids = module.network.platform_subnet_ids

  certificate_arn         = var.certificate_arn
  alb_ingress_cidrs       = var.restrict_alb_to_cloudflare ? module.edge.cloudflare_ipv4_cidrs : ["0.0.0.0/0"]
  alb_deletion_protection = var.deletion_protection

  image_tag        = var.image_tag
  ecr_repositories = concat(keys(local.ports), ["workspace"])
  ecr_force_delete = !var.deletion_protection

  secret_names = local.secret_names
  shared_env   = local.shared_env
  services     = local.services

  task_role_arns = {
    "control-api" = module.runtime.deploy_task_role_arn
  }
  task_role_policy_arns = {
    "builder"  = [aws_iam_policy.builder.arn]
    "console"  = [aws_iam_policy.console.arn]
    "data-api" = [aws_iam_policy.data_api.arn]
  }

  enable_execute_command = var.enable_execute_command
  log_retention_days     = var.log_retention_days
  tags                   = local.tags
}

module "sandboxes" {
  source = "../../modules/sandboxes"

  name               = local.name
  env                = local.env
  vpc_id             = module.network.vpc_id
  vpc_cidr_block     = module.network.vpc_cidr_block
  sandbox_subnet_ids = module.network.sandbox_subnet_ids
  s3_prefix_list_id  = module.network.s3_prefix_list_id

  image  = local.workspace_image
  cpu    = var.sandbox_cpu
  memory = var.sandbox_memory

  efs_id                = module.data.efs_id
  efs_arn               = module.data.efs_arn
  efs_security_group_id = module.data.efs_security_group_id

  platform_security_group_id = module.platform.tasks_security_group_id
  # The coding agent calls the LLM gateway. A dev preview's /api/kelay route calls the Data API and the
  # control API as the app's Development runtime, with the caller token of the dev deploy.
  platform_ports = [local.ports["llm-gateway"], local.ports["data-api"], local.ports["control-api"]]

  environment = {
    LLM_GATEWAY_URL = local.internal_url["llm-gateway"]
  }

  log_retention_days = var.log_retention_days
  tags               = local.tags
}

module "edge" {
  source = "../../modules/edge"

  name          = local.name
  account_id    = var.cloudflare_account_id
  zone_name     = var.zone_name
  app_hostname  = var.app_hostname
  alb_hostnames = values(local.hosts)
  alb_dns_name  = module.platform.alb_dns_name

  router_bundle_path = var.router_bundle_path
  # The bindings services/router/src/index.ts reads, besides ROUTES and the AWS key.
  router_vars = {
    AWS_REGION     = var.region
    MCP_ORIGIN     = "https://${local.hosts.mcp}"
    CONTROL_ORIGIN = "https://${local.hosts.api}"
  }
  router_secrets = var.create_router_access_key ? {
    AWS_ACCESS_KEY_ID     = module.runtime.router_access_key_id
    AWS_SECRET_ACCESS_KEY = module.runtime.router_secret_access_key
  } : {}

  manage_zone_settings = var.manage_zone_settings
  manage_zone_rulesets = var.manage_zone_rulesets
  enable_managed_waf   = var.enable_managed_waf
}

module "observability" {
  source = "../../modules/observability"

  name         = local.name
  alarm_emails = var.alarm_emails

  alb_arn_suffix            = module.platform.alb_arn_suffix
  target_group_arn_suffixes = module.platform.target_group_arn_suffixes
  ecs_cluster_name          = module.platform.cluster_name
  ecs_service_names         = module.platform.service_names
  aurora_cluster_id         = module.data.cluster_id

  enable_clickhouse                = var.enable_clickhouse
  clickhouse_ip_allowlist          = [for ip in module.network.nat_public_ips : "${ip}/32"]
  clickhouse_min_replica_memory_gb = var.clickhouse_min_replica_memory_gb
  clickhouse_max_replica_memory_gb = var.clickhouse_max_replica_memory_gb
  clickhouse_password_secret_arn   = module.platform.secret_arns["clickhouse-password"]

  tags = local.tags
}

################################################################################
# Extra task permissions
################################################################################

# The Deploy service runs inside control-api: it also starts agent-graph runs.
resource "aws_iam_role_policy_attachment" "deploy_orchestrator" {
  role       = module.runtime.deploy_task_role_name
  policy_arn = module.runtime.orchestrator_policy_arn
}

# Storage API (inside data-api): presigned URLs under each app's prefix.
data "aws_iam_policy_document" "data_api" {
  statement {
    sid       = "AppFiles"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${module.data.app_files_bucket_arn}/apps/*"]
  }

  statement {
    sid       = "ListAppFiles"
    actions   = ["s3:ListBucket"]
    resources = [module.data.app_files_bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["apps/*"]
    }
  }
}

resource "aws_iam_policy" "data_api" {
  name   = "${local.name}-data-api-files"
  policy = data.aws_iam_policy_document.data_api.json
}

# The Builder starts and stops workspace tasks, and stores the bundles it fetched from them where
# the Deploy role reads them. A workspace task itself has neither permission.
data "aws_iam_policy_document" "builder" {
  source_policy_documents = [module.sandboxes.launcher_policy_json]

  statement {
    sid       = "StoreBuildBundles"
    actions   = ["s3:PutObject"]
    resources = ["${module.data.artifacts_bucket_arn}/builds/*"]
  }
}

resource "aws_iam_policy" "builder" {
  name   = "${local.name}-builder"
  policy = data.aws_iam_policy_document.builder.json
}

# Builder agent transcripts, stored per builder.
data "aws_iam_policy_document" "console" {
  statement {
    sid       = "Transcripts"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${module.data.artifacts_bucket_arn}/transcripts/*"]
  }
}

resource "aws_iam_policy" "console" {
  name   = "${local.name}-console-transcripts"
  policy = data.aws_iam_policy_document.console.json
}
