data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # /16 layout: public /24s at .0-.2, data /24s at .8-.10, platform /20s at .16-.63, sandboxes /20s at .64-.111.
  public_cidrs   = [for i in range(var.az_count) : cidrsubnet(var.cidr, 8, i)]
  data_cidrs     = [for i in range(var.az_count) : cidrsubnet(var.cidr, 8, 8 + i)]
  platform_cidrs = [for i in range(var.az_count) : cidrsubnet(var.cidr, 4, 1 + i)]
  sandbox_cidrs  = [for i in range(var.az_count) : cidrsubnet(var.cidr, 4, 4 + i)]
}

# Tiers map onto the community module as:
#   public   -> ALB and NAT
#   private  -> platform services (default route through NAT for model providers)
#   intra    -> builder sandboxes (no internet route; reach AWS through endpoints)
#   database -> Aurora, RDS Proxy, EFS mount targets (no internet route)
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.7"

  name = var.name
  cidr = var.cidr
  azs  = local.azs

  public_subnets   = local.public_cidrs
  private_subnets  = local.platform_cidrs
  intra_subnets    = local.sandbox_cidrs
  database_subnets = local.data_cidrs

  public_subnet_suffix   = "public"
  private_subnet_suffix  = "platform"
  intra_subnet_suffix    = "sandbox"
  database_subnet_suffix = "data"

  create_database_subnet_group       = true
  create_database_subnet_route_table = true

  enable_nat_gateway     = true
  single_nat_gateway     = var.single_nat_gateway
  one_nat_gateway_per_az = !var.single_nat_gateway

  enable_dns_hostnames = true
  enable_dns_support   = true

  map_public_ip_on_launch = false

  manage_default_security_group = true
  default_security_group_name   = "${var.name}-default-deny"

  enable_flow_log                                 = var.enable_flow_log
  create_flow_log_cloudwatch_log_group            = var.enable_flow_log
  create_flow_log_cloudwatch_iam_role             = var.enable_flow_log
  flow_log_max_aggregation_interval               = 60
  flow_log_cloudwatch_log_group_retention_in_days = var.flow_log_retention_days

  public_subnet_tags   = { "kelay:tier" = "public" }
  private_subnet_tags  = { "kelay:tier" = "platform" }
  intra_subnet_tags    = { "kelay:tier" = "sandbox" }
  database_subnet_tags = { "kelay:tier" = "data" }

  tags = var.tags
}

module "endpoints" {
  source  = "terraform-aws-modules/vpc/aws//modules/vpc-endpoints"
  version = "~> 6.7"

  vpc_id = module.vpc.vpc_id

  create_security_group      = var.enable_interface_endpoints
  security_group_name_prefix = "${var.name}-endpoints-"
  security_group_description = "Interface endpoints, HTTPS from inside the VPC"
  security_group_rules = {
    ingress_https = {
      description = "HTTPS from the VPC"
      cidr_blocks = [module.vpc.vpc_cidr_block]
    }
  }

  endpoints = merge(
    {
      s3 = {
        service         = "s3"
        service_type    = "Gateway"
        route_table_ids = concat(module.vpc.private_route_table_ids, module.vpc.intra_route_table_ids, module.vpc.database_route_table_ids)
        tags            = { Name = "${var.name}-s3" }
      }
    },
    {
      for svc in var.interface_endpoints : svc => {
        service             = svc
        subnet_ids          = module.vpc.intra_subnets
        private_dns_enabled = true
        tags                = { Name = "${var.name}-${replace(svc, ".", "-")}" }
      } if var.enable_interface_endpoints
    },
  )

  tags = var.tags
}
