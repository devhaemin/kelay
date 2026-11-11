variable "name" {
  description = "Name prefix for platform-owned IAM resources, e.g. kelay-staging."
  type        = string
}

variable "env" {
  description = "Environment name. Per-app resources must carry kelay:env = this value."
  type        = string
}

variable "app_resource_prefix" {
  description = <<-EOT
    Name prefix of every per-app Lambda function and state machine the Deploy service may manage.
    Keep the default when staging and prod live in separate AWS accounts (recommended). In a shared
    account use a per-env prefix that still starts with kelay-app-, e.g. kelay-app-stg-.
  EOT
  type        = string
  default     = "kelay-app-"

  validation {
    condition     = startswith(var.app_resource_prefix, "kelay-app-")
    error_message = "app_resource_prefix must start with kelay-app-."
  }
}

variable "boundary_name" {
  description = "Name of the permissions boundary for per-app roles."
  type        = string
  default     = "kelay-app-boundary"
}

variable "artifacts_bucket_arn" {
  description = "Bucket holding build bundles under builds/, read by Lambda at deploy time."
  type        = string
}

variable "allow_per_app_roles" {
  description = "Let the Deploy service create kelay-app-* roles, only with the boundary attached."
  type        = bool
  default     = false
}

variable "create_router_access_key" {
  description = <<-EOT
    Create an access key for the Router user and hand it to the edge module. This puts the secret in
    Terraform state. When false, create the key out of band and set it with `wrangler secret put`.
  EOT
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
