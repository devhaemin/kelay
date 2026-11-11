output "app_resource_prefix" {
  value = var.app_resource_prefix
}

output "required_tags" {
  description = "Tags the Deploy service must set on every per-app function and state machine, plus kelay:app."
  value       = local.required_tags
}

output "boundary_arn" {
  value = aws_iam_policy.boundary.arn
}

output "lambda_exec_role_arn" {
  value = aws_iam_role.lambda_exec.arn
}

output "states_exec_role_arn" {
  value = aws_iam_role.states_exec.arn
}

output "deploy_task_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "deploy_task_role_name" {
  value = aws_iam_role.deploy.name
}

output "orchestrator_policy_arn" {
  value = aws_iam_policy.orchestrator.arn
}

output "router_user_name" {
  value = aws_iam_user.router.name
}

output "router_user_arn" {
  value = aws_iam_user.router.arn
}

output "router_access_key_id" {
  value = try(aws_iam_access_key.router[0].id, null)
}

output "router_secret_access_key" {
  value     = try(aws_iam_access_key.router[0].secret, null)
  sensitive = true
}
