variable "aws_account_id" {
  description = "The AWS account this env lives in. Terraform refuses to run against any other account."
  type        = string
  default     = null
}

variable "region" {
  type    = string
  default = "ap-northeast-2"
}

# Edge and hostnames

variable "cloudflare_account_id" {
  type = string
}

variable "zone_name" {
  description = "Cloudflare zone for this env, e.g. kelay.app for prod and a separate zone for staging."
  type        = string
}

variable "app_hostname" {
  description = "Host that serves /<handle>/<app> through the Router Worker (zone apex or a first-level name)."
  type        = string
}

variable "host_labels" {
  description = "First-level labels for platform hosts on the ALB, joined with zone_name."
  type        = map(string)
  default = {
    console = "console"
    api     = "api"
    id      = "id"
    data    = "data"
    llm     = "llm"
    mcp     = "mcp"
    preview = "preview"
    otel    = "otel"
  }
}

variable "certificate_arn" {
  description = "ACM certificate in var.region covering *.zone_name (Cloudflare connects to the ALB with Full strict TLS)."
  type        = string
}

variable "restrict_alb_to_cloudflare" {
  description = "Only Cloudflare's IP ranges may reach the ALB."
  type        = bool
  default     = true
}

variable "router_bundle_path" {
  description = "Built Router Worker bundle, relative to this directory."
  type        = string
  default     = "../../../../services/router/dist/index.js"
}

variable "app_resource_prefix" {
  description = "Prefix of per-app Lambda functions and state machines. Change it only when envs share an AWS account."
  type        = string
  default     = "kelay-app-"
}

variable "create_router_access_key" {
  description = "Let Terraform create the Router's AWS access key and bind it to the Worker (the secret lands in state)."
  type        = bool
  default     = false
}

variable "manage_zone_settings" {
  type    = bool
  default = true
}

variable "manage_zone_rulesets" {
  type    = bool
  default = true
}

variable "enable_managed_waf" {
  type    = bool
  default = false
}

# Network

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "single_nat_gateway" {
  type    = bool
  default = true
}

variable "enable_interface_endpoints" {
  type    = bool
  default = true
}

variable "enable_flow_log" {
  type    = bool
  default = false
}

# Data

variable "aurora_engine_version" {
  type    = string
  default = "17.5"
}

variable "aurora_min_capacity" {
  type    = number
  default = 0
}

variable "aurora_max_capacity" {
  type    = number
  default = 4
}

variable "aurora_instance_count" {
  type    = number
  default = 1
}

variable "db_password_version" {
  description = "Raise it to give the service database logins new passwords; then run the db-bootstrap task and restart the services."
  type        = number
  default     = 1
}

variable "deletion_protection" {
  description = "Aurora and ALB deletion protection; buckets and ECR repos refuse to delete with content when true."
  type        = bool
  default     = true
}

# Platform services

variable "image_tag" {
  description = "Image tag for every service and the workspace image, e.g. the git SHA CI pushed."
  type        = string
}

variable "service_overrides" {
  description = "Per-service sizing and image overrides on top of the defaults in main.tf. env entries are added to the service's own."
  type = map(object({
    image         = optional(string)
    image_tag     = optional(string)
    cpu           = optional(number)
    memory        = optional(number)
    desired_count = optional(number)
    autoscaling   = optional(object({ min = number, max = number }))
    spot          = optional(bool)
    env           = optional(map(string))
  }))
  default = {}
}

variable "identity_social_providers" {
  description = <<-EOT
    Sign-in providers Kelay ID offers. Each one gets two secret shells, <provider>-client-id and
    <provider>-client-secret, which must have values before Kelay ID can start.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for p in var.identity_social_providers : contains(["google", "kakao", "github"], p)])
    error_message = "identity_social_providers may hold google, kakao and github."
  }
}

variable "identity_email_password" {
  description = "Let people sign in to Kelay ID with an email address and a password."
  type        = bool
  default     = false
}

variable "enable_execute_command" {
  type    = bool
  default = false
}

variable "log_retention_days" {
  type    = number
  default = 30
}

# Sandboxes

variable "workspace_image" {
  description = "Builder workspace image; defaults to the workspace ECR repo at image_tag."
  type        = string
  default     = null
}

variable "sandbox_cpu" {
  type    = number
  default = 2048
}

variable "sandbox_memory" {
  type    = number
  default = 4096
}

# Observability

variable "alarm_emails" {
  type    = list(string)
  default = []
}

variable "enable_clickhouse" {
  type    = bool
  default = false
}

variable "clickhouse_min_replica_memory_gb" {
  type    = number
  default = 8
}

variable "clickhouse_max_replica_memory_gb" {
  type    = number
  default = 16
}

variable "builder_allowlist" {
  description = "Emails that become builders when they sign up at Kelay ID with a provider-verified address."
  type        = list(string)
  default     = []
}

variable "open_signup" {
  description = "Let anyone who signs up at Kelay ID become a builder. Keep false outside demos."
  type        = bool
  default     = false
}
