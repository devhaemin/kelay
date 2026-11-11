output "cluster_name" {
  value = module.cluster.name
}

output "cluster_arn" {
  value = module.cluster.arn
}

output "alb_arn" {
  value = module.alb.arn
}

output "alb_arn_suffix" {
  description = "For CloudWatch LoadBalancer dimensions."
  value       = module.alb.arn_suffix
}

output "alb_dns_name" {
  value = module.alb.dns_name
}

output "alb_zone_id" {
  value = module.alb.zone_id
}

output "alb_security_group_id" {
  value = module.alb.security_group_id
}

output "tasks_security_group_id" {
  value = aws_security_group.tasks.id
}

output "target_group_arn_suffixes" {
  description = "Per load-balanced service, for CloudWatch TargetGroup dimensions."
  value       = { for k, tg in module.alb.target_groups : k => tg.arn_suffix }
}

output "service_names" {
  value = { for k, s in module.service : k => s.name }
}

output "task_role_arns" {
  value = { for k, s in module.service : k => coalesce(s.tasks_iam_role_arn, lookup(var.task_role_arns, k, null)) }
}

output "task_role_names" {
  description = "Module-created task roles only."
  value       = { for k, s in module.service : k => s.tasks_iam_role_name if s.tasks_iam_role_name != null }
}

output "ecr_repository_urls" {
  value = { for k, r in module.ecr : k => r.repository_url }
}

output "ecr_repository_arns" {
  value = { for k, r in module.ecr : k => r.repository_arn }
}

output "secret_arns" {
  value = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

output "internal_domain" {
  value = local.internal_domain
}

output "internal_urls" {
  description = "In-VPC base URLs, e.g. http://llm-gateway.staging.kelay.internal:4000."
  value       = { for k, s in var.services : k => "http://${k}.${local.internal_domain}:${s.port}" }
}

output "service_ports" {
  value = { for k, s in var.services : k => s.port }
}
