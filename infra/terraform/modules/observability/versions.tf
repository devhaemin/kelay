terraform {
  required_version = ">= 1.11, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.72, < 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.9, < 4.0"
    }
    clickhouse = {
      source  = "ClickHouse/clickhouse"
      version = ">= 3.43, < 4.0"
    }
  }
}
