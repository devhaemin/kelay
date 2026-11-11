data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  engine_major = split(".", var.engine_version)[0]

  # Postgres logins of the platform services. The master user is left to RDS, which rotates its
  # password; nothing but the bootstrap task below logs in with it.
  db_users = {
    platform = var.platform_db_username
    litellm  = var.litellm_db_username
  }

  db_client_rules = {
    for i, sg in var.db_client_security_group_ids : "client-${i}" => {
      description                  = "Postgres from platform services"
      from_port                    = 5432
      to_port                      = 5432
      referenced_security_group_id = sg
    }
  }
}

################################################################################
# Aurora PostgreSQL Serverless v2
################################################################################

module "aurora" {
  source  = "terraform-aws-modules/rds-aurora/aws"
  version = "~> 10.4"

  name           = var.name
  engine         = "aurora-postgresql"
  engine_mode    = "provisioned"
  engine_version = var.engine_version
  database_name  = var.database_name

  master_username             = var.master_username
  manage_master_user_password = true

  storage_encrypted                   = true
  iam_database_authentication_enabled = true

  vpc_id               = var.vpc_id
  db_subnet_group_name = var.database_subnet_group_name

  security_group_name = "${var.name}-aurora"
  security_group_ingress_rules = merge(local.db_client_rules, {
    proxy = {
      description                  = "Postgres from RDS Proxy"
      from_port                    = 5432
      to_port                      = 5432
      referenced_security_group_id = aws_security_group.proxy.id
    }
  })

  cluster_instance_class = "db.serverless"
  instances              = { for i in range(var.instance_count) : "i${i + 1}" => {} }

  serverlessv2_scaling_configuration = {
    min_capacity             = var.min_capacity
    max_capacity             = var.max_capacity
    seconds_until_auto_pause = var.min_capacity == 0 ? var.seconds_until_auto_pause : null
  }

  cluster_parameter_group = {
    name        = "${var.name}-aurora-pg${local.engine_major}"
    family      = "aurora-postgresql${local.engine_major}"
    description = "Kelay Aurora PostgreSQL ${local.engine_major} cluster parameters"
    parameters = [
      { name = "rds.force_ssl", value = "1" },
    ]
  }

  backup_retention_period   = var.backup_retention_days
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = "${var.name}-final"
  apply_immediately         = var.apply_immediately
  copy_tags_to_snapshot     = true

  enabled_cloudwatch_logs_exports        = ["postgresql"]
  create_cloudwatch_log_group            = true
  cloudwatch_log_group_retention_in_days = var.log_retention_days

  tags = var.tags
}

################################################################################
# RDS Proxy (the only way platform services reach Postgres at runtime)
################################################################################

resource "aws_security_group" "proxy" {
  name        = "${var.name}-rds-proxy"
  description = "RDS Proxy in front of Aurora"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-rds-proxy" })
}

resource "aws_vpc_security_group_ingress_rule" "proxy_from_clients" {
  for_each = local.db_client_rules

  security_group_id            = aws_security_group.proxy.id
  description                  = each.value.description
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value.referenced_security_group_id
}

resource "aws_vpc_security_group_egress_rule" "proxy_to_aurora" {
  security_group_id            = aws_security_group.proxy.id
  description                  = "Postgres to Aurora"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = module.aurora.security_group_id
}

module "proxy" {
  source  = "terraform-aws-modules/rds-proxy/aws"
  version = "~> 4.4"

  name                   = var.name
  iam_role_name          = "${var.name}-rds-proxy"
  vpc_subnet_ids         = var.data_subnet_ids
  vpc_security_group_ids = [aws_security_group.proxy.id]

  engine_family       = "POSTGRESQL"
  require_tls         = true
  idle_client_timeout = 1800
  debug_logging       = false

  auth = merge(
    {
      master = {
        auth_scheme               = "SECRETS"
        description               = "Aurora master user, managed by RDS in Secrets Manager"
        iam_auth                  = var.proxy_iam_auth
        client_password_auth_type = "POSTGRES_SCRAM_SHA_256"
        secret_arn                = module.aurora.cluster_master_user_secret[0].secret_arn
      }
    },
    {
      for k, secret in aws_secretsmanager_secret.db_user : k => {
        auth_scheme               = "SECRETS"
        description               = "Login of the ${k} services"
        iam_auth                  = var.proxy_iam_auth
        client_password_auth_type = "POSTGRES_SCRAM_SHA_256"
        secret_arn                = secret.arn
      }
    },
  )

  target_db_cluster     = true
  db_cluster_identifier = module.aurora.cluster_id

  max_connections_percent      = 90
  max_idle_connections_percent = 50

  manage_log_group            = true
  log_group_retention_in_days = var.log_retention_days

  tags = var.tags
}

################################################################################
# Service logins: one Secrets Manager secret per login, in the {username, password} shape RDS Proxy
# and ECS both read. The roles themselves are created in Postgres by the bootstrap task.
################################################################################

# Ephemeral: the passwords go to Secrets Manager as write-only values and never into state.
ephemeral "random_password" "db_user" {
  for_each = local.db_users

  length  = 40
  special = false
}

resource "aws_secretsmanager_secret" "db_user" {
  for_each = local.db_users

  name                    = "${var.name}/db-${each.key}"
  description             = "Postgres login ${each.value}. Written by Terraform; run the ${var.name}-db-bootstrap task after it changes."
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "db_user" {
  for_each = local.db_users

  secret_id                = aws_secretsmanager_secret.db_user[each.key].id
  secret_string_wo         = jsonencode({ username = each.value, password = ephemeral.random_password.db_user[each.key].result })
  secret_string_wo_version = var.db_password_version
}

################################################################################
# Bootstrap task: creates the service logins and their databases as the master user. Run it once
# after the first apply and again after db_password_version changes (aws ecs run-task).
################################################################################

resource "aws_cloudwatch_log_group" "db_bootstrap" {
  name              = "/kelay/${var.env}/db-bootstrap"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

data "aws_iam_policy_document" "db_bootstrap_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

data "aws_iam_policy_document" "db_bootstrap_exec" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.db_bootstrap.arn}:*"]
  }

  statement {
    sid     = "DatabaseLogins"
    actions = ["secretsmanager:GetSecretValue"]
    resources = concat(
      [module.aurora.cluster_master_user_secret[0].secret_arn],
      [for secret in aws_secretsmanager_secret.db_user : secret.arn],
    )
  }
}

resource "aws_iam_role" "db_bootstrap_exec" {
  name               = "${var.name}-db-bootstrap-exec"
  description        = "Execution role of the ${var.name}-db-bootstrap task: reads the database logins and writes its log."
  assume_role_policy = data.aws_iam_policy_document.db_bootstrap_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "db_bootstrap_exec" {
  name   = "read-database-logins"
  role   = aws_iam_role.db_bootstrap_exec.id
  policy = data.aws_iam_policy_document.db_bootstrap_exec.json
}

resource "aws_ecs_task_definition" "db_bootstrap" {
  family                   = "${var.name}-db-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.db_bootstrap_exec.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "db-bootstrap"
    image     = var.db_bootstrap_image
    essential = true
    command   = ["sh", "-c", file("${path.module}/db-bootstrap.sh")]

    # Straight to the writer: the proxy only knows the logins this task is about to create.
    environment = [
      { name = "PGHOST", value = module.aurora.cluster_endpoint },
      { name = "PGPORT", value = tostring(module.aurora.cluster_port) },
      { name = "PGDATABASE", value = "postgres" },
      { name = "PGSSLMODE", value = "require" },
      { name = "CONTROL_DATABASE", value = var.database_name },
      { name = "LITELLM_DATABASE", value = var.litellm_database_name },
    ]

    secrets = [
      { name = "PGUSER", valueFrom = "${module.aurora.cluster_master_user_secret[0].secret_arn}:username::" },
      { name = "PGPASSWORD", valueFrom = "${module.aurora.cluster_master_user_secret[0].secret_arn}:password::" },
      { name = "PLATFORM_USER", valueFrom = "${aws_secretsmanager_secret.db_user["platform"].arn}:username::" },
      { name = "PLATFORM_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db_user["platform"].arn}:password::" },
      { name = "LITELLM_USER", valueFrom = "${aws_secretsmanager_secret.db_user["litellm"].arn}:username::" },
      { name = "LITELLM_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db_user["litellm"].arn}:password::" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.db_bootstrap.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "run"
      }
    }
  }])

  tags = var.tags

  depends_on = [aws_secretsmanager_secret_version.db_user]
}

################################################################################
# EFS for builder workspaces. Access points are created per workspace at runtime.
################################################################################

module "efs" {
  source  = "terraform-aws-modules/efs/aws"
  version = "~> 2.2"

  name             = "${var.name}-workspaces"
  creation_token   = "${var.name}-workspaces"
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "elastic"

  lifecycle_policy = {
    transition_to_ia                    = "AFTER_30_DAYS"
    transition_to_primary_storage_class = "AFTER_1_ACCESS"
  }

  mount_targets = { for i, s in var.data_subnet_ids : "az${i}" => { subnet_id = s } }

  security_group_name        = "${var.name}-efs"
  security_group_description = "EFS mount targets for builder workspaces"
  security_group_vpc_id      = var.vpc_id
  security_group_ingress_rules = {
    for i, sg in var.efs_client_security_group_ids : "client-${i}" => {
      description                  = "NFS from builder sandboxes"
      referenced_security_group_id = sg
    }
  }

  # Untrusted sandboxes mount only through a per-workspace access point (which pins the
  # POSIX user and root directory), never the file system root, and never as root.
  attach_policy                             = true
  deny_nonsecure_transport                  = true
  deny_nonsecure_transport_via_mount_target = false
  policy_statements = length(var.efs_client_role_arns) > 0 ? {
    access_point_mounts = {
      sid        = "MountThroughAccessPointsOnly"
      effect     = "Allow"
      actions    = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      principals = [{ type = "AWS", identifiers = var.efs_client_role_arns }]
      condition = [
        { test = "Bool", variable = "elasticfilesystem:AccessedViaMountTarget", values = ["true"] },
        { test = "Null", variable = "elasticfilesystem:AccessPointArn", values = ["false"] },
      ]
    }
  } : null

  enable_backup_policy = true

  tags = var.tags
}

################################################################################
# S3
################################################################################

module "app_files" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 5.17"

  bucket        = "${var.name}-app-files-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.force_destroy_buckets

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  control_object_ownership = true
  object_ownership         = "BucketOwnerEnforced"

  attach_deny_insecure_transport_policy = true
  attach_require_latest_tls_policy      = true

  versioning = { enabled = true }

  server_side_encryption_configuration = {
    rule = {
      bucket_key_enabled                      = true
      apply_server_side_encryption_by_default = { sse_algorithm = "AES256" }
    }
  }

  cors_rule = length(var.app_files_cors_origins) > 0 ? [{
    id              = "presigned-browser-access"
    allowed_methods = ["GET", "PUT", "HEAD"]
    allowed_origins = var.app_files_cors_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }] : []

  lifecycle_rule = [
    {
      id                                     = "abort-incomplete-uploads"
      enabled                                = true
      abort_incomplete_multipart_upload_days = 7
    },
    {
      id                            = "expire-old-versions"
      enabled                       = true
      noncurrent_version_expiration = { noncurrent_days = 30 }
      expiration                    = { expired_object_delete_marker = true }
    },
    {
      id         = "intelligent-tiering"
      enabled    = true
      transition = [{ days = 30, storage_class = "INTELLIGENT_TIERING" }]
    },
  ]

  tags = merge(var.tags, { "kelay:bucket" = "app-files" })
}

module "artifacts" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 5.17"

  bucket        = "${var.name}-artifacts-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.force_destroy_buckets

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

  control_object_ownership = true
  object_ownership         = "BucketOwnerEnforced"

  attach_deny_insecure_transport_policy = true
  attach_require_latest_tls_policy      = true

  versioning = { enabled = true }

  server_side_encryption_configuration = {
    rule = {
      bucket_key_enabled                      = true
      apply_server_side_encryption_by_default = { sse_algorithm = "AES256" }
    }
  }

  lifecycle_rule = [
    {
      id                                     = "abort-incomplete-uploads"
      enabled                                = true
      abort_incomplete_multipart_upload_days = 7
    },
    {
      id                            = "expire-old-versions"
      enabled                       = true
      noncurrent_version_expiration = { noncurrent_days = 90 }
      expiration                    = { expired_object_delete_marker = true }
    },
    {
      id         = "expire-old-builds"
      enabled    = true
      filter     = { prefix = "builds/" }
      expiration = { days = var.build_retention_days }
    },
  ]

  tags = merge(var.tags, { "kelay:bucket" = "artifacts" })
}
