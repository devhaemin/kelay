variable "name" {
  description = "Name prefix, e.g. kelay-staging."
  type        = string
}

variable "alarm_emails" {
  description = "Email addresses subscribed to the alarm topic (each must confirm)."
  type        = list(string)
  default     = []
}

# Targets

variable "alb_arn_suffix" {
  type = string
}

variable "target_group_arn_suffixes" {
  description = "Load-balanced service name => target group ARN suffix."
  type        = map(string)
  default     = {}
}

variable "ecs_cluster_name" {
  type = string
}

variable "ecs_service_names" {
  description = "Service key => ECS service name."
  type        = map(string)
  default     = {}
}

variable "aurora_cluster_id" {
  type = string
}

# Thresholds

variable "alb_5xx_threshold" {
  description = "5xx responses per 5 minutes before alarming (ALB-generated and per target group)."
  type        = number
  default     = 10
}

variable "ecs_cpu_threshold" {
  description = "Average service CPU percent over 15 minutes."
  type        = number
  default     = 85
}

variable "aurora_acu_utilization_threshold" {
  description = "Aurora ACUUtilization percent (of max capacity) over 15 minutes."
  type        = number
  default     = 90
}

# ClickHouse Cloud (optional)

variable "enable_clickhouse" {
  description = "Create a ClickHouse Cloud service for telemetry. Needs CLICKHOUSE_ORG_ID, CLICKHOUSE_CLOUD_API_KEY and CLICKHOUSE_CLOUD_API_SECRET."
  type        = bool
  default     = false
}

variable "clickhouse_region" {
  type    = string
  default = "ap-northeast-2"
}

variable "clickhouse_ip_allowlist" {
  description = "CIDRs allowed to connect, normally the platform NAT IPs as /32."
  type        = list(string)
  default     = []
}

variable "clickhouse_min_replica_memory_gb" {
  type    = number
  default = 8
}

variable "clickhouse_max_replica_memory_gb" {
  type    = number
  default = 16
}

variable "clickhouse_idle_timeout_minutes" {
  type    = number
  default = 15
}

variable "clickhouse_password_secret_arn" {
  description = "Secrets Manager secret that receives the default user password (required when enable_clickhouse)."
  type        = string
  default     = null
}

variable "clickhouse_password_version" {
  description = "Bump to rotate the ClickHouse password; the new value goes to ClickHouse and the secret together."
  type        = number
  default     = 1
}

variable "tags" {
  type    = map(string)
  default = {}
}
