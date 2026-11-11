variable "name" {
  description = "Name prefix for every resource, e.g. kelay-staging."
  type        = string
}

variable "cidr" {
  description = "VPC CIDR. Must be a /16 so the subnet layout below fits."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrhost(var.cidr, 0)) && endswith(var.cidr, "/16")
    error_message = "cidr must be a valid IPv4 /16."
  }
}

variable "az_count" {
  description = "Number of availability zones."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "One shared NAT gateway (cheaper) instead of one per AZ (survives an AZ outage)."
  type        = bool
  default     = true
}

variable "enable_interface_endpoints" {
  description = "Create interface endpoints so the sandbox tier (no internet route) can pull images and ship logs."
  type        = bool
  default     = true
}

variable "interface_endpoints" {
  description = "Interface endpoint services placed in the sandbox subnets when enable_interface_endpoints is true."
  type        = list(string)
  default     = ["ecr.api", "ecr.dkr", "logs"]
}

variable "enable_flow_log" {
  description = "Send VPC flow logs to CloudWatch Logs."
  type        = bool
  default     = false
}

variable "flow_log_retention_days" {
  description = "Retention for the flow log group."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Extra tags for every resource."
  type        = map(string)
  default     = {}
}
