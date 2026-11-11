variable "name" {
  description = "Name prefix, e.g. kelay-staging."
  type        = string
}

variable "account_id" {
  description = "Cloudflare account ID that owns the Worker and KV namespace."
  type        = string
}

variable "zone_name" {
  description = "Cloudflare zone, e.g. kelay.app. Use one zone per environment."
  type        = string
}

variable "app_hostname" {
  description = "App domain served by the Router Worker at /<handle>/<app> (the zone apex or a first-level name)."
  type        = string
}

variable "alb_hostnames" {
  description = "Hostnames proxied straight to the ALB (console, Control API, Kelay ID, gateways)."
  type        = list(string)
}

variable "alb_dns_name" {
  type = string
}

variable "router_script_name" {
  type    = string
  default = null
}

variable "router_bundle_path" {
  description = "Path to the built Router Worker ES module bundle (one file), relative to the working directory."
  type        = string
}

variable "router_compatibility_date" {
  type    = string
  default = "2026-10-01"
}

variable "router_compatibility_flags" {
  type    = list(string)
  default = ["nodejs_compat"]
}

variable "router_vars" {
  description = "Plain-text bindings for the Router: AWS_REGION, MCP_ORIGIN and CONTROL_ORIGIN (services/router/src/index.ts)."
  type        = map(string)
  default     = {}
}

variable "router_secrets" {
  description = <<-EOT
    Secret bindings managed by Terraform (e.g. the Router's AWS access key). Leave empty to manage
    secrets with `wrangler secret put`; secret_text bindings are then kept across uploads.
  EOT
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "manage_zone_settings" {
  description = "Set SSL to Full (strict), minimum TLS 1.2 and Always Use HTTPS on the zone."
  type        = bool
  default     = true
}

variable "manage_zone_rulesets" {
  description = "Own the zone's rate-limit and custom firewall entrypoint rulesets (one owner per zone)."
  type        = bool
  default     = true
}

variable "enable_managed_waf" {
  description = "Deploy the Cloudflare Managed Ruleset (needs a Pro plan or higher)."
  type        = bool
  default     = false
}

variable "mcp_requests_per_period" {
  description = "Requests per IP per 10 seconds on /<handle>/<app>/mcp before blocking."
  type        = number
  default     = 100
}
