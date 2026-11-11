data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
  }
}

data "cloudflare_ip_ranges" "this" {}

locals {
  zone_id     = data.cloudflare_zone.this.id
  script_name = coalesce(var.router_script_name, "${var.name}-router")

  # Cloudflare's own managed ruleset ID, the same in every account.
  managed_ruleset_id = "efb7b8c949ac4650a09736fc376e9aee"
}

################################################################################
# DNS
################################################################################

# Originless placeholder: the Worker route answers every request on the app domain.
resource "cloudflare_dns_record" "app" {
  zone_id = local.zone_id
  name    = var.app_hostname
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
  comment = "Kelay ${var.name} app domain, served by the Router Worker"
}

resource "cloudflare_dns_record" "alb" {
  for_each = toset(var.alb_hostnames)

  zone_id = local.zone_id
  name    = each.key
  type    = "CNAME"
  content = var.alb_dns_name
  proxied = true
  ttl     = 1
  comment = "Kelay ${var.name} platform host on the ALB"
}

resource "cloudflare_zone_setting" "ssl" {
  count = var.manage_zone_settings ? 1 : 0

  zone_id    = local.zone_id
  setting_id = "ssl"
  value      = "strict"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  count = var.manage_zone_settings ? 1 : 0

  zone_id    = local.zone_id
  setting_id = "min_tls_version"
  value      = "1.2"
}

resource "cloudflare_zone_setting" "always_use_https" {
  count = var.manage_zone_settings ? 1 : 0

  zone_id    = local.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

################################################################################
# Router Worker
################################################################################

resource "cloudflare_workers_kv_namespace" "routes" {
  account_id = var.account_id
  title      = "${var.name}-routes"
}

resource "cloudflare_workers_script" "router" {
  account_id  = var.account_id
  script_name = local.script_name

  content_file   = var.router_bundle_path
  content_sha256 = filesha256(var.router_bundle_path)
  main_module    = basename(var.router_bundle_path)

  compatibility_date  = var.router_compatibility_date
  compatibility_flags = var.router_compatibility_flags

  bindings = concat(
    [{ name = "ROUTES", type = "kv_namespace", namespace_id = cloudflare_workers_kv_namespace.routes.id }],
    [for k, v in var.router_vars : { name = k, type = "plain_text", text = v }],
    [for k, v in var.router_secrets : { name = k, type = "secret_text", text = v }],
  )

  keep_bindings = length(var.router_secrets) == 0 ? ["secret_text"] : null

  observability = {
    enabled            = true
    head_sampling_rate = 1
  }
}

resource "cloudflare_workers_route" "app" {
  zone_id = local.zone_id
  pattern = "${var.app_hostname}/*"
  script  = cloudflare_workers_script.router.script_name
}

################################################################################
# WAF and rate limiting
################################################################################

resource "cloudflare_ruleset" "rate_limit" {
  count = var.manage_zone_rulesets ? 1 : 0

  zone_id     = local.zone_id
  name        = "${var.name} rate limits"
  description = "Per-IP limits in front of the MCP gateway"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [{
    ref         = "mcp_per_ip"
    description = "MCP calls per IP"
    expression  = "(http.host eq \"${var.app_hostname}\" and ends_with(http.request.uri.path, \"/mcp\"))"
    action      = "block"
    ratelimit = {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = 10
      requests_per_period = var.mcp_requests_per_period
      mitigation_timeout  = 10
    }
  }]
}

resource "cloudflare_ruleset" "firewall_custom" {
  count = var.manage_zone_rulesets ? 1 : 0

  zone_id     = local.zone_id
  name        = "${var.name} custom firewall"
  description = "Keep service-only endpoints off the public internet"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [{
    ref         = "block_internal_paths"
    description = "Service-to-service /internal/ routes are reached over private DNS only"
    expression  = "(starts_with(http.request.uri.path, \"/internal/\"))"
    action      = "block"
  }]
}

resource "cloudflare_ruleset" "managed_waf" {
  count = var.manage_zone_rulesets && var.enable_managed_waf ? 1 : 0

  zone_id     = local.zone_id
  name        = "${var.name} managed WAF"
  description = "Cloudflare Managed Ruleset"
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules = [{
    ref         = "cloudflare_managed"
    description = "Cloudflare Managed Ruleset"
    expression  = "true"
    action      = "execute"
    action_parameters = {
      id = local.managed_ruleset_id
    }
  }]
}
