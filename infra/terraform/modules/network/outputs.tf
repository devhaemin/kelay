output "vpc_id" {
  value = module.vpc.vpc_id
}

output "vpc_cidr_block" {
  value = module.vpc.vpc_cidr_block
}

output "azs" {
  value = local.azs
}

output "public_subnet_ids" {
  value = module.vpc.public_subnets
}

output "platform_subnet_ids" {
  value = module.vpc.private_subnets
}

output "sandbox_subnet_ids" {
  value = module.vpc.intra_subnets
}

output "data_subnet_ids" {
  value = module.vpc.database_subnets
}

output "database_subnet_group_name" {
  value = module.vpc.database_subnet_group_name
}

output "nat_public_ips" {
  description = "Egress IPs of the platform tier, for provider-side allowlists."
  value       = module.vpc.nat_public_ips
}

output "s3_prefix_list_id" {
  description = "Prefix list of the S3 gateway endpoint, for security group egress rules."
  value       = module.endpoints.endpoints["s3"].prefix_list_id
}

output "endpoints_security_group_id" {
  description = "Security group on the interface endpoints; null when they are disabled."
  value       = try(module.endpoints.security_group_id, null)
}
