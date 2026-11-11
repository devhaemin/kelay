terraform {
  required_version = ">= 1.11, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.72"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
    clickhouse = {
      source  = "ClickHouse/clickhouse"
      version = "~> 3.43"
    }
  }

  # Partial config: pass the bucket with `terraform init -backend-config=backend.hcl`.
  backend "s3" {
    key          = "kelay/prod/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }
}
