locals {
  lb_services = { for k, s in var.services : k => s if length(s.host_headers) + length(s.path_patterns) > 0 }

  ecr_repositories = toset(concat([for k, s in var.services : k if s.image == null], var.extra_ecr_repositories))

  images = {
    for k, s in var.services : k => s.image != null ? s.image : "${try(module.ecr[k].repository_url, "")}:${coalesce(s.image_tag, var.image_tag)}"
  }

  secret_refs = {
    for k, s in var.services : k => {
      for env_name, ref in s.secrets : env_name => startswith(ref, "arn:") ? ref : aws_secretsmanager_secret.this[ref].arn
    }
  }

  # Execution roles are granted the bare secret ARN, without a ":json-key:stage:version" suffix.
  # No distinct(): ARNs are unknown at plan time and the list length must stay known.
  secret_base_arns = {
    for k, refs in local.secret_refs : k => [for r in values(refs) : join(":", slice(split(":", r), 0, 7))]
  }

  service_ports = toset([for s in var.services : tostring(s.port)])
  lb_ports      = toset(flatten([for s in local.lb_services : [tostring(s.port), tostring(coalesce(s.health_port, s.port))]]))

  internal_domain = "${var.env}.kelay.internal"
}

################################################################################
# Secrets (shells only; values are put with the AWS CLI or console)
################################################################################

resource "aws_secretsmanager_secret" "this" {
  for_each = toset(var.secret_names)

  name                    = "${var.name}/${each.key}"
  description             = "Kelay ${var.env} ${each.key}. The value is set out of band, never by Terraform."
  recovery_window_in_days = 7
  tags                    = var.tags
}

################################################################################
# ECR
################################################################################

module "ecr" {
  source   = "terraform-aws-modules/ecr/aws"
  version  = "~> 3.2"
  for_each = local.ecr_repositories

  repository_name                 = "${var.name}/${each.key}"
  repository_image_tag_mutability = "IMMUTABLE"
  repository_image_scan_on_push   = true
  repository_force_delete         = var.ecr_force_delete

  create_repository_policy = false
  attach_repository_policy = false

  repository_lifecycle_policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 50 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 50
      }
      action = { type = "expire" }
    }]
  })

  tags = var.tags
}

################################################################################
# Service discovery: <service>.<env>.kelay.internal for in-VPC callers (services, sandboxes)
################################################################################

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = local.internal_domain
  description = "Kelay ${var.env} platform services"
  vpc         = var.vpc_id
  tags        = var.tags
}

resource "aws_service_discovery_service" "this" {
  for_each = var.services

  name = each.key

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  force_destroy = true
  tags          = var.tags
}

################################################################################
# Security group shared by platform tasks
################################################################################

resource "aws_security_group" "tasks" {
  name        = "${var.name}-platform-tasks"
  description = "Kelay platform services on Fargate"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-platform-tasks" })
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  for_each = local.lb_ports

  security_group_id            = aws_security_group.tasks.id
  description                  = "ALB to service port ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = tonumber(each.key)
  to_port                      = tonumber(each.key)
  referenced_security_group_id = module.alb.security_group_id
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_tasks" {
  for_each = local.service_ports

  security_group_id            = aws_security_group.tasks.id
  description                  = "Service to service on port ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = tonumber(each.key)
  to_port                      = tonumber(each.key)
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_vpc_security_group_egress_rule" "tasks_all" {
  security_group_id = aws_security_group.tasks.id
  description       = "Model providers, AWS APIs and in-VPC dependencies"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

################################################################################
# ALB
################################################################################

module "alb" {
  source  = "terraform-aws-modules/alb/aws"
  version = "~> 10.5"

  name               = var.name
  load_balancer_type = "application"
  internal           = false
  vpc_id             = var.vpc_id
  subnets            = var.public_subnet_ids

  enable_deletion_protection = var.alb_deletion_protection
  drop_invalid_header_fields = true
  idle_timeout               = var.alb_idle_timeout

  access_logs = var.alb_access_logs_bucket != null ? {
    bucket = var.alb_access_logs_bucket
    prefix = "alb/${var.env}"
  } : null

  security_group_name        = "${var.name}-alb"
  security_group_description = "Kelay ${var.env} ALB"
  security_group_ingress_rules = merge(
    { for i, cidr in var.alb_ingress_cidrs : "https-${i}" => { description = "HTTPS", from_port = 443, to_port = 443, ip_protocol = "tcp", cidr_ipv4 = cidr } },
    { for i, cidr in var.alb_ingress_cidrs : "http-${i}" => { description = "HTTP redirect", from_port = 80, to_port = 80, ip_protocol = "tcp", cidr_ipv4 = cidr } },
  )
  security_group_egress_rules = {
    vpc = {
      description = "To targets in the VPC"
      ip_protocol = "-1"
      cidr_ipv4   = var.vpc_cidr_block
    }
  }

  listeners = {
    http = {
      port     = 80
      protocol = "HTTP"
      redirect = {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }

    https = {
      port                        = 443
      protocol                    = "HTTPS"
      certificate_arn             = var.certificate_arn
      additional_certificate_arns = var.additional_certificate_arns
      ssl_policy                  = var.ssl_policy

      fixed_response = {
        content_type = "application/json"
        status_code  = "404"
        message_body = jsonencode({ error = { code = "not_found", message = "No route for this host or path" } })
      }

      rules = {
        for k, s in local.lb_services : k => {
          priority = s.priority
          actions  = [{ forward = { target_group_key = k } }]
          conditions = concat(
            [for v in [s.host_headers] : { host_header = { values = v } } if length(v) > 0],
            [for v in [s.path_patterns] : { path_pattern = { values = v } } if length(v) > 0],
          )
        }
      }
    }
  }

  target_groups = {
    for k, s in local.lb_services : k => {
      name                 = substr("${var.name}-${k}", 0, 32)
      protocol             = "HTTP"
      port                 = s.port
      target_type          = "ip"
      deregistration_delay = 30
      create_attachment    = false

      health_check = {
        enabled             = true
        port                = s.health_port != null ? tostring(s.health_port) : "traffic-port"
        path                = s.health_path
        matcher             = s.health_matcher
        interval            = 15
        timeout             = 5
        healthy_threshold   = 2
        unhealthy_threshold = 3
      }
    }
  }

  tags = var.tags
}

################################################################################
# ECS cluster and services
################################################################################

module "cluster" {
  source  = "terraform-aws-modules/ecs/aws//modules/cluster"
  version = "~> 7.6"

  name = var.name

  setting = [{ name = "containerInsights", value = "enabled" }]

  cluster_capacity_providers = ["FARGATE", "FARGATE_SPOT"]
  default_capacity_provider_strategy = {
    FARGATE = { weight = 100, base = 1 }
  }

  cloudwatch_log_group_retention_in_days = var.log_retention_days

  tags = var.tags
}

module "service" {
  source   = "terraform-aws-modules/ecs/aws//modules/service"
  version  = "~> 7.6"
  for_each = var.services

  name        = each.key
  family      = "${var.name}-${each.key}"
  cluster_arn = module.cluster.arn

  cpu    = each.value.cpu
  memory = each.value.memory
  runtime_platform = {
    cpu_architecture        = each.value.cpu_architecture
    operating_system_family = "LINUX"
  }

  desired_count            = each.value.desired_count
  enable_autoscaling       = each.value.autoscaling != null
  autoscaling_min_capacity = try(each.value.autoscaling.min, 1)
  autoscaling_max_capacity = try(each.value.autoscaling.max, 1)

  capacity_provider_strategy = {
    default = {
      capacity_provider = each.value.spot ? "FARGATE_SPOT" : "FARGATE"
      weight            = 100
    }
  }

  subnet_ids            = var.platform_subnet_ids
  security_group_ids    = [aws_security_group.tasks.id]
  create_security_group = false
  assign_public_ip      = false

  enable_execute_command     = var.enable_execute_command
  deployment_circuit_breaker = { enable = true, rollback = true }
  wait_for_steady_state      = false

  health_check_grace_period_seconds = contains(keys(local.lb_services), each.key) ? 60 : null
  load_balancer = contains(keys(local.lb_services), each.key) ? {
    service = {
      target_group_arn = try(module.alb.target_groups[each.key].arn, null)
      container_name   = each.key
      container_port   = each.value.port
    }
  } : null

  service_registries = {
    registry_arn = aws_service_discovery_service.this[each.key].arn
  }

  container_definitions = {
    (each.key) = {
      image     = local.images[each.key]
      essential = true
      command   = each.value.command

      portMappings = concat(
        [{ name = "http", containerPort = each.value.port, hostPort = each.value.port, protocol = "tcp" }],
        [for p in(each.value.health_port != null ? [each.value.health_port] : []) : { name = "health", containerPort = p, hostPort = p, protocol = "tcp" } if p != each.value.port],
      )

      environment = [
        for k, v in merge(var.shared_env, { KELAY_SERVICE = each.key, PORT = tostring(each.value.port) }, each.value.env) : { name = k, value = v }
      ]
      secrets = [for k, v in local.secret_refs[each.key] : { name = k, valueFrom = v }]

      readonlyRootFilesystem = each.value.readonly_root_filesystem
      linuxParameters        = { initProcessEnabled = true }

      enable_cloudwatch_logging              = true
      create_cloudwatch_log_group            = true
      cloudwatch_log_group_name              = "/kelay/${var.env}/${each.key}"
      cloudwatch_log_group_retention_in_days = var.log_retention_days
    }
  }

  task_exec_iam_role_name     = "${var.name}-${each.key}-exec"
  task_exec_secret_arns       = local.secret_base_arns[each.key]
  create_tasks_iam_role       = !contains(keys(var.task_role_arns), each.key)
  tasks_iam_role_arn          = lookup(var.task_role_arns, each.key, null)
  tasks_iam_role_name         = "${var.name}-${each.key}-task"
  tasks_iam_role_policies     = { for i, arn in lookup(var.task_role_policy_arns, each.key, []) : "policy-${i}" => arn }
  tasks_iam_role_description  = "Kelay ${var.env} ${each.key} task role"
  task_exec_iam_role_policies = {}

  tags = merge(var.tags, { "kelay:service" = each.key })
}
