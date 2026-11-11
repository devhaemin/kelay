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
    "preview-proxy"  = 4005
    "console"        = 3000
    "otel-collector" = 4318
  }
  internal_domain = "${local.env}.kelay.internal"
  internal_url    = { for svc, port in local.ports : svc => "http://${svc}.${local.internal_domain}:${port}" }

  # Secrets Manager shells. Terraform never writes their values (clickhouse-password excepted, write-only).
  secret_names = [
    "kelay-caller-secret",
    "control-database-url",
    "better-auth-secret",
    "google-client-secret",
    "kakao-client-secret",
    "github-client-secret",
    "llm-gateway-key",
    "litellm-master-key",
    "litellm-salt-key",
    "litellm-database-url",
    "anthropic-api-key",
    "openai-api-key",
    "gemini-api-key",
    "forgejo-token",
    "cloudflare-kv-token",
    "clickhouse-password",
  ]

  db_secret = module.data.master_user_secret_arn

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
    DB_HOST                     = module.data.proxy_endpoint
    DB_PORT                     = "5432"
    APP_FILES_BUCKET            = module.data.app_files_bucket
    ARTIFACTS_BUCKET            = module.data.artifacts_bucket
  }

  base_services = {
    console = {
      port         = local.ports["console"]
      cpu          = 512
      memory       = 1024
      host_headers = [local.hosts.console]
      priority     = 10
      env          = { PUBLIC_URL = "https://${local.hosts.console}" }
      secrets      = { KELAY_CALLER_SECRET = "kelay-caller-secret" }
    }

    control-api = {
      port         = local.ports["control-api"]
      cpu          = 512
      memory       = 1024
      host_headers = [local.hosts.api]
      priority     = 20
      env = {
        APP_RESOURCE_PREFIX    = module.runtime.app_resource_prefix
        LAMBDA_EXEC_ROLE_ARN   = module.runtime.lambda_exec_role_arn
        STATES_EXEC_ROLE_ARN   = module.runtime.states_exec_role_arn
        SANDBOX_CLUSTER_ARN    = module.sandboxes.cluster_arn
        SANDBOX_TASK_FAMILY    = module.sandboxes.task_definition_family
        SANDBOX_TASK_TEMPLATE  = module.sandboxes.task_definition_arn
        SANDBOX_SUBNET_IDS     = join(",", module.sandboxes.subnet_ids)
        SANDBOX_SECURITY_GROUP = module.sandboxes.security_group_id
        WORKSPACES_EFS_ID      = module.data.efs_id
        CLOUDFLARE_ACCOUNT_ID  = var.cloudflare_account_id
        ROUTES_KV_NAMESPACE_ID = module.edge.routes_kv_namespace_id
        APP_DOMAIN             = var.app_hostname
        FORGEJO_URL            = var.forgejo_url
      }
      secrets = {
        CONTROL_DATABASE_URL = "control-database-url"
        KELAY_CALLER_SECRET  = "kelay-caller-secret"
        LLM_GATEWAY_KEY      = "llm-gateway-key"
        FORGEJO_TOKEN        = "forgejo-token"
        CLOUDFLARE_API_TOKEN = "cloudflare-kv-token"
        DB_USER              = "${local.db_secret}:username::"
        DB_PASSWORD          = "${local.db_secret}:password::"
      }
    }

    identity = {
      port         = local.ports["identity"]
      host_headers = [local.hosts.id]
      priority     = 30
      env          = { BETTER_AUTH_URL = "https://${local.hosts.id}" }
      secrets = {
        CONTROL_DATABASE_URL = "control-database-url"
        BETTER_AUTH_SECRET   = "better-auth-secret"
        GOOGLE_CLIENT_SECRET = "google-client-secret"
        KAKAO_CLIENT_SECRET  = "kakao-client-secret"
        GITHUB_CLIENT_SECRET = "github-client-secret"
      }
    }

    data-api = {
      port         = local.ports["data-api"]
      cpu          = 512
      memory       = 1024
      host_headers = [local.hosts.data]
      priority     = 40
      secrets = {
        CONTROL_DATABASE_URL = "control-database-url"
        KELAY_CALLER_SECRET  = "kelay-caller-secret"
        DB_USER              = "${local.db_secret}:username::"
        DB_PASSWORD          = "${local.db_secret}:password::"
      }
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
      }
      secrets = {
        LITELLM_MASTER_KEY = "litellm-master-key"
        LITELLM_SALT_KEY   = "litellm-salt-key"
        DATABASE_URL       = "litellm-database-url"
        ANTHROPIC_API_KEY  = "anthropic-api-key"
        OPENAI_API_KEY     = "openai-api-key"
        GEMINI_API_KEY     = "gemini-api-key"
      }
    }

    # No service implements the preview proxy yet: the builder service is expected to take this name,
    # port and host. Until its image exists the service is held at zero tasks, which keeps the ALB
    # rule, the DNS name and the ECR repository in place.
    preview-proxy = {
      port          = local.ports["preview-proxy"]
      host_headers  = [local.hosts.preview]
      priority      = 70
      desired_count = 0
    }

    otel-collector = {
      port         = local.ports["otel-collector"]
      cpu          = 512
      memory       = 1024
      host_headers = [local.hosts.otel]
      priority     = 80
      health_path  = "/"
      health_port  = 13133
      secrets      = { CLICKHOUSE_PASSWORD = "clickhouse-password" }
    }
  }

  services = {
    for k, s in local.base_services : k => merge(s, {
      for attr, value in try(var.service_overrides[k], {}) : attr => value if value != null
    })
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

  image  = coalesce(var.workspace_image, "${module.platform.ecr_repository_urls["workspace"]}:${var.image_tag}")
  cpu    = var.sandbox_cpu
  memory = var.sandbox_memory

  efs_id                = module.data.efs_id
  efs_arn               = module.data.efs_arn
  efs_security_group_id = module.data.efs_security_group_id

  platform_security_group_id = module.platform.tasks_security_group_id
  platform_ports             = [local.ports["llm-gateway"]]

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
  router_vars = {
    KELAY_ENV           = local.env
    AWS_REGION          = var.region
    APP_RESOURCE_PREFIX = module.runtime.app_resource_prefix
    MCP_ORIGIN          = "https://${local.hosts.mcp}"
    PREVIEW_ORIGIN      = "https://${local.hosts.preview}"
    KELAY_ID_ISSUER     = "https://${local.hosts.id}"
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

# The Deploy service runs inside control-api: it also starts workspaces and agent-graph runs.
resource "aws_iam_role_policy" "deploy_sandboxes" {
  name   = "launch-workspaces"
  role   = module.runtime.deploy_task_role_name
  policy = module.sandboxes.launcher_policy_json
}

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
