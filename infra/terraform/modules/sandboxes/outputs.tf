output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "task_definition_arn" {
  description = "Template revision; copy it with an access point per workspace."
  value       = aws_ecs_task_definition.workspace.arn
}

output "task_definition_family" {
  value = aws_ecs_task_definition.workspace.family
}

output "container_name" {
  value = local.container_name
}

output "security_group_id" {
  value = aws_security_group.this.id
}

output "subnet_ids" {
  value = var.sandbox_subnet_ids
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}

output "launcher_policy_json" {
  description = "Attach to the role of the service that starts workspaces (the Control API)."
  value       = data.aws_iam_policy_document.launcher.json
}
