variable "name" {
  description = "Name prefix, e.g. kelay-staging."
  type        = string
}

variable "env" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr_block" {
  description = "Sandboxes may reach HTTPS inside the VPC (interface endpoints) and nothing else on 443."
  type        = string
}

variable "sandbox_subnet_ids" {
  description = "Sandbox tier subnets (no internet route)."
  type        = list(string)
}

variable "s3_prefix_list_id" {
  description = "S3 gateway endpoint prefix list, for ECR image layers."
  type        = string
}

variable "image" {
  description = "Builder workspace image: the fixed SDK toolchain plus the coding agent."
  type        = string
}

variable "cpu" {
  type    = number
  default = 2048
}

variable "memory" {
  type    = number
  default = 4096
}

variable "cpu_architecture" {
  type    = string
  default = "X86_64"
}

variable "ephemeral_storage_gib" {
  description = "Scratch disk for node_modules and build output; the working tree lives on EFS."
  type        = number
  default     = 50
}

variable "preview_port" {
  description = "Port of `next dev` inside the workspace, reached only by the preview proxy."
  type        = number
  default     = 3000
}

variable "runtime_port" {
  description = "Port of the workspace runtime inside the task, which the Builder drives the workspace through."
  type        = number
  default     = 4007
}

variable "workspace_path" {
  type    = string
  default = "/workspace"
}

variable "environment" {
  description = "Non-secret env for the workspace container. Per-run values (repo, scoped gateway key) come as RunTask overrides."
  type        = map(string)
  default     = {}
}

variable "efs_id" {
  type = string
}

variable "efs_arn" {
  type = string
}

variable "efs_security_group_id" {
  type = string
}

variable "platform_security_group_id" {
  description = "Platform tasks security group: the Builder reaches the workspace runtime and the dev preview from it, and workspaces call the platform ports in it."
  type        = string
}

variable "platform_ports" {
  description = "Platform service ports sandboxes may call over private DNS (the LLM gateway, and the Data API and the control API for dev previews)."
  type        = list(number)
  default     = []
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "tags" {
  type    = map(string)
  default = {}
}
