resource "aws_sns_topic" "alarms" {
  name = "${var.name}-alarms"
  tags = var.tags
}

resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alarm_emails)

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.key
}

locals {
  actions = [aws_sns_topic.alarms.arn]
}

################################################################################
# ALB
################################################################################

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name        = "${var.name}-alb-5xx"
  alarm_description = "The ALB itself returned 5xx (no healthy target, timeouts)."
  namespace         = "AWS/ApplicationELB"
  metric_name       = "HTTPCode_ELB_5XX_Count"
  dimensions        = { LoadBalancer = var.alb_arn_suffix }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alb_5xx_threshold
  treat_missing_data  = "notBreaching"

  alarm_actions = local.actions
  ok_actions    = local.actions
  tags          = var.tags
}

resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  for_each = var.target_group_arn_suffixes

  alarm_name        = "${var.name}-${each.key}-5xx"
  alarm_description = "${each.key} returned 5xx through the ALB."
  namespace         = "AWS/ApplicationELB"
  metric_name       = "HTTPCode_Target_5XX_Count"
  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = each.value
  }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alb_5xx_threshold
  treat_missing_data  = "notBreaching"

  alarm_actions = local.actions
  ok_actions    = local.actions
  tags          = var.tags
}

################################################################################
# ECS
################################################################################

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each = var.ecs_service_names

  alarm_name        = "${var.name}-${each.key}-cpu"
  alarm_description = "${each.key} CPU above ${var.ecs_cpu_threshold}% for 15 minutes."
  namespace         = "AWS/ECS"
  metric_name       = "CPUUtilization"
  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = each.value
  }

  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.ecs_cpu_threshold
  treat_missing_data  = "missing"

  alarm_actions = local.actions
  ok_actions    = local.actions
  tags          = var.tags
}

################################################################################
# Aurora
################################################################################

resource "aws_cloudwatch_metric_alarm" "aurora_capacity" {
  alarm_name        = "${var.name}-aurora-capacity"
  alarm_description = "Aurora Serverless v2 is near its max ACUs; raise max_capacity or shard app databases."
  namespace         = "AWS/RDS"
  metric_name       = "ACUUtilization"
  dimensions        = { DBClusterIdentifier = var.aurora_cluster_id }

  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.aurora_acu_utilization_threshold
  treat_missing_data  = "notBreaching"

  alarm_actions = local.actions
  ok_actions    = local.actions
  tags          = var.tags
}

################################################################################
# ClickHouse Cloud (telemetry store)
################################################################################

# Ephemeral: the password goes to ClickHouse and Secrets Manager as write-only values and never into state.
ephemeral "random_password" "clickhouse" {
  count = var.enable_clickhouse ? 1 : 0

  length  = 40
  special = false
}

resource "clickhouse_service" "telemetry" {
  count = var.enable_clickhouse ? 1 : 0

  name           = "${var.name}-telemetry"
  cloud_provider = "aws"
  region         = var.clickhouse_region

  min_replica_memory_gb = var.clickhouse_min_replica_memory_gb
  max_replica_memory_gb = var.clickhouse_max_replica_memory_gb
  idle_scaling          = true
  idle_timeout_minutes  = var.clickhouse_idle_timeout_minutes

  ip_access = [
    for cidr in var.clickhouse_ip_allowlist : {
      source      = cidr
      description = "Kelay platform egress"
    }
  ]

  password_wo         = ephemeral.random_password.clickhouse[0].result
  password_wo_version = var.clickhouse_password_version

  tags = var.tags

  lifecycle {
    precondition {
      condition     = var.clickhouse_password_secret_arn != null
      error_message = "Set clickhouse_password_secret_arn when enable_clickhouse is true."
    }
  }
}

resource "aws_secretsmanager_secret_version" "clickhouse_password" {
  count = var.enable_clickhouse ? 1 : 0

  secret_id                = var.clickhouse_password_secret_arn
  secret_string_wo         = ephemeral.random_password.clickhouse[0].result
  secret_string_wo_version = var.clickhouse_password_version
}
