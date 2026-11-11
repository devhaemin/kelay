data "aws_caller_identity" "current" {}

locals {
  engine_major = split(".", var.engine_version)[0]

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

  auth = {
    master = {
      auth_scheme               = "SECRETS"
      description               = "Aurora master user, managed by RDS in Secrets Manager"
      iam_auth                  = var.proxy_iam_auth
      client_password_auth_type = "POSTGRES_SCRAM_SHA_256"
      secret_arn                = module.aurora.cluster_master_user_secret[0].secret_arn
    }
  }

  target_db_cluster     = true
  db_cluster_identifier = module.aurora.cluster_id

  max_connections_percent      = 90
  max_idle_connections_percent = 50

  manage_log_group            = true
  log_group_retention_in_days = var.log_retention_days

  tags = var.tags
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
