output "zone_id" {
  value = local.zone_id
}

output "routes_kv_namespace_id" {
  description = "Workers KV namespace bound as ROUTES; the Deploy service writes app routes here."
  value       = cloudflare_workers_kv_namespace.routes.id
}

output "router_script_name" {
  value = cloudflare_workers_script.router.script_name
}

output "cloudflare_ipv4_cidrs" {
  description = "Cloudflare egress ranges, for restricting the ALB to edge traffic."
  value       = data.cloudflare_ip_ranges.this.ipv4_cidrs
}
