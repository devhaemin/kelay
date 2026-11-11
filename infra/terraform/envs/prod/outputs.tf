output "hosts" {
  description = "Public hostnames: the app domain on the Router Worker, the rest on the ALB."
  value       = merge(local.hosts, { app = var.app_hostname })
}

output "alb_dns_name" {
  value = module.platform.alb_dns_name
}

output "nat_public_ips" {
  value = module.network.nat_public_ips
}

output "ecs_cluster_name" {
  value = module.platform.cluster_name
}

output "internal_urls" {
  value = module.platform.internal_urls
}

output "ecr_repository_urls" {
  value = module.platform.ecr_repository_urls
}

output "secret_arns" {
  description = "Secrets to fill with `aws secretsmanager put-secret-value` before services can start."
  value       = module.platform.secret_arns
}

output "aurora_cluster_endpoint" {
  value = module.data.cluster_endpoint
}

output "db_proxy_endpoint" {
  value = module.data.proxy_endpoint
}

output "db_master_secret_arn" {
  value = module.data.master_user_secret_arn
}

output "app_files_bucket" {
  value = module.data.app_files_bucket
}

output "artifacts_bucket" {
  value = module.data.artifacts_bucket
}

output "workspaces_efs_id" {
  value = module.data.efs_id
}

output "sandbox" {
  value = {
    cluster_arn       = module.sandboxes.cluster_arn
    task_family       = module.sandboxes.task_definition_family
    task_template_arn = module.sandboxes.task_definition_arn
    subnet_ids        = module.sandboxes.subnet_ids
    security_group_id = module.sandboxes.security_group_id
  }
}

output "runtime" {
  description = "What the Deploy service needs to create per-app functions and state machines."
  value = {
    app_resource_prefix  = module.runtime.app_resource_prefix
    required_tags        = module.runtime.required_tags
    lambda_exec_role_arn = module.runtime.lambda_exec_role_arn
    states_exec_role_arn = module.runtime.states_exec_role_arn
    deploy_task_role_arn = module.runtime.deploy_task_role_arn
    boundary_arn         = module.runtime.boundary_arn
    router_user_name     = module.runtime.router_user_name
  }
}

output "routes_kv_namespace_id" {
  value = module.edge.routes_kv_namespace_id
}

output "router_script_name" {
  value = module.edge.router_script_name
}

output "alarm_topic_arn" {
  value = module.observability.alarm_topic_arn
}

output "clickhouse_service_id" {
  value = module.observability.clickhouse_service_id
}
