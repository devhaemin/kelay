output "cluster_id" {
  value = module.aurora.cluster_id
}

output "cluster_arn" {
  value = module.aurora.cluster_arn
}

output "cluster_endpoint" {
  description = "Writer endpoint, for migrations run from inside the VPC."
  value       = module.aurora.cluster_endpoint
}

output "cluster_port" {
  value = module.aurora.cluster_port
}

output "aurora_security_group_id" {
  value = module.aurora.security_group_id
}

output "master_user_secret_arn" {
  description = "Secrets Manager secret (JSON username/password) managed by RDS."
  value       = module.aurora.cluster_master_user_secret[0].secret_arn
}

output "proxy_endpoint" {
  description = "RDS Proxy endpoint that platform services connect to."
  value       = module.proxy.proxy_endpoint
}

output "proxy_arn" {
  value = module.proxy.proxy_arn
}

output "proxy_security_group_id" {
  value = aws_security_group.proxy.id
}

output "efs_id" {
  value = module.efs.id
}

output "efs_arn" {
  value = module.efs.arn
}

output "efs_security_group_id" {
  value = module.efs.security_group_id
}

output "app_files_bucket" {
  value = module.app_files.s3_bucket_id
}

output "app_files_bucket_arn" {
  value = module.app_files.s3_bucket_arn
}

output "artifacts_bucket" {
  value = module.artifacts.s3_bucket_id
}

output "artifacts_bucket_arn" {
  value = module.artifacts.s3_bucket_arn
}
