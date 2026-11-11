provider "aws" {
  region              = var.region
  allowed_account_ids = var.aws_account_id != null ? [var.aws_account_id] : null

  default_tags {
    tags = {
      Project     = "kelay"
      Environment = local.env
      ManagedBy   = "terraform"
    }
  }
}

# Reads CLOUDFLARE_API_TOKEN from the environment.
provider "cloudflare" {}

# Terraform configures this provider even when no ClickHouse resource is planned, so placeholders keep
# plans working with the feature off. With it on, CLICKHOUSE_ORG_ID, CLICKHOUSE_CLOUD_API_KEY and
# CLICKHOUSE_CLOUD_API_SECRET from the environment apply.
provider "clickhouse" {
  organization_id = var.enable_clickhouse ? null : "00000000-0000-0000-0000-000000000000"
  token_key       = var.enable_clickhouse ? null : "disabled"
  token_secret    = var.enable_clickhouse ? null : "disabled"
}
