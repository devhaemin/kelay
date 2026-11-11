variable "name" {
  description = "Name prefix, e.g. kelay-staging."
  type        = string
}

variable "env" {
  description = "Environment name, e.g. staging or prod. Names the bootstrap task's log group."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "data_subnet_ids" {
  description = "Data tier subnets for the proxy and EFS mount targets."
  type        = list(string)
}

variable "database_subnet_group_name" {
  description = "DB subnet group over the data tier, from the network module."
  type        = string
}

variable "db_client_security_group_ids" {
  description = "Security groups allowed to reach Postgres (platform services)."
  type        = list(string)
}

variable "efs_client_security_group_ids" {
  description = "Security groups allowed to mount EFS (builder sandboxes)."
  type        = list(string)
}

variable "efs_client_role_arns" {
  description = "IAM roles allowed to mount EFS, and only through an access point."
  type        = list(string)
  default     = []
}

# Aurora

variable "engine_version" {
  description = "Aurora PostgreSQL version. Scale-to-zero needs 13.15+, 14.12+, 15.7+, 16.3+ or 17.x."
  type        = string
  default     = "17.5"
}

variable "database_name" {
  description = "Initial database; the control DB. App databases are created at runtime by the Control API."
  type        = string
  default     = "kelay_control"
}

variable "master_username" {
  type    = string
  default = "kelay_admin"
}

variable "platform_db_username" {
  description = "Postgres login of control-api, identity and data-api. Owns the control DB and every app database."
  type        = string
  default     = "kelay_platform"
}

variable "litellm_db_username" {
  description = "Postgres login of the LLM gateway."
  type        = string
  default     = "kelay_litellm"
}

variable "litellm_database_name" {
  description = "Database the LLM gateway keeps its keys and spend logs in."
  type        = string
  default     = "litellm"
}

variable "db_password_version" {
  description = <<-EOT
    Raise it to give the service logins new passwords. Afterwards run the db-bootstrap task, which
    sets them in Postgres, and restart the services. Until the task has run, new connections fail.
  EOT
  type        = number
  default     = 1
}

variable "db_bootstrap_image" {
  description = "Image with psql for the bootstrap task."
  type        = string
  default     = "public.ecr.aws/docker/library/postgres:17"
}

variable "min_capacity" {
  description = "Minimum ACUs. 0 lets the cluster auto-pause when idle; 0.5 keeps it warm."
  type        = number
  default     = 0

  validation {
    condition     = var.min_capacity == 0 || var.min_capacity >= 0.5
    error_message = "min_capacity must be 0 or at least 0.5."
  }
}

variable "max_capacity" {
  description = "Maximum ACUs."
  type        = number
  default     = 4
}

variable "seconds_until_auto_pause" {
  description = "Idle seconds before pausing; used only when min_capacity is 0."
  type        = number
  default     = 3600
}

variable "instance_count" {
  description = "Serverless v2 instances: 1 writer plus N-1 readers."
  type        = number
  default     = 1
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "skip_final_snapshot" {
  type    = bool
  default = false
}

variable "apply_immediately" {
  type    = bool
  default = false
}

variable "log_retention_days" {
  type    = number
  default = 30
}

# RDS Proxy

variable "proxy_iam_auth" {
  description = "Client IAM auth on the proxy: DISABLED (the login's password) or REQUIRED (rds-db:connect tokens)."
  type        = string
  default     = "DISABLED"

  validation {
    condition     = contains(["DISABLED", "REQUIRED"], var.proxy_iam_auth)
    error_message = "proxy_iam_auth must be DISABLED or REQUIRED."
  }
}

# S3

variable "app_files_cors_origins" {
  description = "Browser origins allowed to PUT/GET app files through presigned URLs."
  type        = list(string)
  default     = []
}

variable "build_retention_days" {
  description = "Days to keep build bundles under builds/ in the artifacts bucket. Lambda keeps its own copy of deployed code."
  type        = number
  default     = 180
}

variable "force_destroy_buckets" {
  description = "Allow terraform destroy to delete non-empty buckets. Keep false outside throwaway envs."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
