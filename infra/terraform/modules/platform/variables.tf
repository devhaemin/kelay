variable "name" {
  description = "Name prefix, e.g. kelay-staging."
  type        = string
}

variable "env" {
  description = "Environment name, e.g. staging or prod."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr_block" {
  type = string
}

variable "public_subnet_ids" {
  description = "Subnets for the ALB."
  type        = list(string)
}

variable "platform_subnet_ids" {
  description = "Private subnets for the Fargate services."
  type        = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate in this region for the HTTPS listener (e.g. *.kelay.example and the apex)."
  type        = string
}

variable "additional_certificate_arns" {
  description = "Extra ACM certificates attached to the HTTPS listener through SNI."
  type        = list(string)
  default     = []
}

variable "ssl_policy" {
  type    = string
  default = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "alb_ingress_cidrs" {
  description = "IPv4 ranges allowed to reach the ALB. Pass Cloudflare's ranges to force traffic through the edge."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "alb_idle_timeout" {
  description = "Seconds. Long enough for streamed model responses and HMR websockets."
  type        = number
  default     = 300
}

variable "alb_deletion_protection" {
  type    = bool
  default = true
}

variable "alb_access_logs_bucket" {
  description = "Existing S3 bucket for ALB access logs; null disables them."
  type        = string
  default     = null
}

variable "image_tag" {
  description = "Default image tag for services built into this module's ECR repositories (e.g. a git SHA)."
  type        = string
}

variable "extra_ecr_repositories" {
  description = "Additional ECR repositories to create, e.g. the builder workspace image."
  type        = list(string)
  default     = []
}

variable "ecr_force_delete" {
  type    = bool
  default = false
}

variable "secret_names" {
  description = "Secrets Manager secrets to create as empty shells. Values are written out of band, never by Terraform."
  type        = list(string)
  default     = []
}

variable "shared_env" {
  description = "Environment variables injected into every service. Per-service env wins on conflicts."
  type        = map(string)
  default     = {}
}

variable "services" {
  description = <<-EOT
    Platform services keyed by name. A service gets an ALB rule when it has host_headers or path_patterns
    (then priority is required). secrets maps ENV_VAR to either a name from secret_names or a full Secrets
    Manager ARN, optionally with a ":json-key::" suffix.
  EOT
  type = map(object({
    image                    = optional(string)
    image_tag                = optional(string)
    port                     = number
    cpu                      = optional(number, 256)
    memory                   = optional(number, 512)
    cpu_architecture         = optional(string, "X86_64")
    desired_count            = optional(number, 1)
    autoscaling              = optional(object({ min = number, max = number }))
    spot                     = optional(bool, false)
    command                  = optional(list(string))
    env                      = optional(map(string), {})
    secrets                  = optional(map(string), {})
    health_path              = optional(string, "/healthz")
    health_matcher           = optional(string, "200-399")
    host_headers             = optional(list(string), [])
    path_patterns            = optional(list(string), [])
    priority                 = optional(number)
    readonly_root_filesystem = optional(bool, false)
  }))

  validation {
    condition = alltrue([
      for k, s in var.services : can(regex("^[a-z][a-z0-9-]{1,24}$", k))
    ])
    error_message = "Service names must match ^[a-z][a-z0-9-]{1,24}$."
  }

  validation {
    condition = alltrue([
      for k, s in var.services : s.priority != null if length(s.host_headers) + length(s.path_patterns) > 0
    ])
    error_message = "Services with host_headers or path_patterns need a listener rule priority."
  }
}

variable "task_role_arns" {
  description = "Existing task role per service name (e.g. the Deploy service role for control-api). Others get a fresh role."
  type        = map(string)
  default     = {}
}

variable "task_role_policy_arns" {
  description = "Managed policy ARNs to attach to the module-created task role of each service."
  type        = map(list(string))
  default     = {}
}

variable "enable_execute_command" {
  description = "ECS Exec into platform tasks. Leave off in production."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
