data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  partition = data.aws_partition.current.partition
  region    = data.aws_region.current.region
  account   = data.aws_caller_identity.current.account_id

  family         = "${var.name}-workspace"
  container_name = "workspace"
  log_group_name = "/kelay/${var.env}/sandboxes"

  platform_ports = toset([for p in var.platform_ports : tostring(p)])
}

################################################################################
# Cluster: untrusted workspaces run apart from platform services
################################################################################

resource "aws_ecs_cluster" "this" {
  name = "${var.name}-sandboxes"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = var.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 100
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

################################################################################
# IAM: pull image and write logs; mount EFS only through an access point. Nothing else.
################################################################################

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-sandbox-exec"
  description        = "Pulls the workspace image and writes its logs."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "MountWorkspaceAccessPoint"
    actions   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
    resources = [var.efs_arn]

    condition {
      test     = "Null"
      variable = "elasticfilesystem:AccessPointArn"
      values   = ["false"]
    }
  }
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-sandbox-task"
  description        = "Untrusted builder workspace. Holds no AWS permissions beyond its EFS access point."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "task" {
  name   = "efs-access-point"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

################################################################################
# Security group: restricted egress (no internet)
################################################################################

resource "aws_security_group" "this" {
  name        = "${var.name}-sandboxes"
  description = "Builder workspaces: EFS, VPC endpoints, S3 and named platform ports only"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-sandboxes" })
}

resource "aws_vpc_security_group_egress_rule" "efs" {
  security_group_id            = aws_security_group.this.id
  description                  = "NFS to EFS mount targets"
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
  referenced_security_group_id = var.efs_security_group_id
}

resource "aws_vpc_security_group_egress_rule" "endpoints" {
  security_group_id = aws_security_group.this.id
  description       = "HTTPS to interface endpoints in the VPC"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.vpc_cidr_block
}

resource "aws_vpc_security_group_egress_rule" "s3" {
  security_group_id = aws_security_group.this.id
  description       = "HTTPS to S3 through the gateway endpoint (image layers)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = var.s3_prefix_list_id
}

resource "aws_vpc_security_group_egress_rule" "platform" {
  for_each = local.platform_ports

  security_group_id            = aws_security_group.this.id
  description                  = "Platform service port ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = tonumber(each.key)
  to_port                      = tonumber(each.key)
  referenced_security_group_id = var.platform_security_group_id
}

resource "aws_vpc_security_group_ingress_rule" "platform_from_sandboxes" {
  for_each = local.platform_ports

  security_group_id            = var.platform_security_group_id
  description                  = "Builder sandboxes to port ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = tonumber(each.key)
  to_port                      = tonumber(each.key)
  referenced_security_group_id = aws_security_group.this.id
}

resource "aws_vpc_security_group_ingress_rule" "preview" {
  security_group_id            = aws_security_group.this.id
  description                  = "Preview proxy to next dev (HTTP and HMR websocket)"
  ip_protocol                  = "tcp"
  from_port                    = var.preview_port
  to_port                      = var.preview_port
  referenced_security_group_id = var.platform_security_group_id
}

resource "aws_vpc_security_group_ingress_rule" "runtime" {
  security_group_id            = aws_security_group.this.id
  description                  = "Builder to the workspace runtime"
  ip_protocol                  = "tcp"
  from_port                    = var.runtime_port
  to_port                      = var.runtime_port
  referenced_security_group_id = var.platform_security_group_id
}

################################################################################
# Task definition template. RunTask cannot override volumes, so the Builder registers a
# definition per workspace, `<family>-<app>`, with that workspace's EFS access point
# (services/builder/src/drivers/fargate.ts). This one fixes the family name, the roles and
# the sizes those definitions use.
################################################################################

resource "aws_ecs_task_definition" "workspace" {
  family                   = local.family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  ephemeral_storage {
    size_in_gib = var.ephemeral_storage_gib
  }

  volume {
    name = "workspace"

    efs_volume_configuration {
      file_system_id     = var.efs_id
      transit_encryption = "ENABLED"

      authorization_config {
        iam = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([{
    name      = local.container_name
    image     = var.image
    essential = true

    portMappings = [{
      name          = "preview"
      containerPort = var.preview_port
      protocol      = "tcp"
    }]

    environment = [
      for k, v in merge({ KELAY_ENV = var.env, WORKSPACE_DIR = var.workspace_path, PORT = tostring(var.preview_port) }, var.environment) : { name = k, value = v }
    ]

    mountPoints = [{
      sourceVolume  = "workspace"
      containerPath = var.workspace_path
      readOnly      = false
    }]

    linuxParameters = {
      initProcessEnabled = true
      capabilities       = { drop = ["NET_RAW", "SYS_PTRACE", "MKNOD"] }
    }

    stopTimeout = 30

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = local.region
        awslogs-stream-prefix = "workspace"
      }
    }
  }])

  tags = merge(var.tags, { "kelay:purpose" = "builder-workspace-template" })
}

################################################################################
# Policy for the service that launches workspaces (the Builder)
################################################################################

data "aws_iam_policy_document" "launcher" {
  statement {
    sid       = "RunWorkspaces"
    actions   = ["ecs:RunTask"]
    resources = ["arn:${local.partition}:ecs:${local.region}:${local.account}:task-definition/${local.family}*:*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  statement {
    sid       = "ManageWorkspaceTasks"
    actions   = ["ecs:StopTask", "ecs:DescribeTasks", "ecs:TagResource"]
    resources = ["arn:${local.partition}:ecs:${local.region}:${local.account}:task/${aws_ecs_cluster.this.name}/*"]
  }

  statement {
    sid       = "ListTasksInCluster"
    actions   = ["ecs:ListTasks"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  statement {
    sid       = "RegisterWorkspaceRevisions"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:DeregisterTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "TagWorkspaceRevisions"
    actions   = ["ecs:TagResource"]
    resources = ["arn:${local.partition}:ecs:${local.region}:${local.account}:task-definition/${local.family}*:*"]
  }

  statement {
    sid       = "PassWorkspaceRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "WorkspaceAccessPoints"
    actions   = ["elasticfilesystem:CreateAccessPoint", "elasticfilesystem:TagResource"]
    resources = [var.efs_arn]
  }

  statement {
    sid     = "ManageAccessPoints"
    actions = ["elasticfilesystem:DeleteAccessPoint", "elasticfilesystem:DescribeAccessPoints", "elasticfilesystem:TagResource"]
    resources = [
      var.efs_arn,
      "arn:${local.partition}:elasticfilesystem:${local.region}:${local.account}:access-point/*",
    ]
  }
}
