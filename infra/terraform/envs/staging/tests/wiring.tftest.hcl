# Plans this env against mock providers and checks that the services get the settings their code
# reads. It needs no credentials and reaches no account:
#
#   terraform init -backend=false && terraform test
#
# Identical in every env (like main.tf). A service's settings are checked by name: at plan time most
# values (ARNs, endpoints) are not known yet.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
  mock_data "aws_region" {
    defaults = { region = "ap-northeast-2", name = "ap-northeast-2" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["ap-northeast-2a", "ap-northeast-2b", "ap-northeast-2c"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

mock_provider "cloudflare" {
  mock_data "cloudflare_zone" {
    defaults = { id = "0123456789abcdef0123456789abcdef", zone_id = "0123456789abcdef0123456789abcdef" }
  }
  mock_data "cloudflare_ip_ranges" {
    defaults = { ipv4_cidrs = ["173.245.48.0/20", "103.21.244.0/22"] }
  }
}

mock_provider "clickhouse" {}
mock_provider "random" {}

variables {
  aws_account_id        = "111111111111"
  cloudflare_account_id = "00000000000000000000000000000000"
  zone_name             = "kelay.example"
  app_hostname          = "kelay.example"
  certificate_arn       = "arn:aws:acm:ap-northeast-2:111111111111:certificate/00000000-0000-0000-0000-000000000000"
  image_tag             = "test"
  # Only hashed here; the real bundle is services/router/dist/index.js.
  router_bundle_path = "../../../../services/router/src/index.ts"
}

run "services_get_what_they_read" {
  command = plan

  variables {
    identity_social_providers = ["google", "kakao"]
    identity_email_password   = true
  }

  assert {
    condition = alltrue([
      for name in ["KELAY_DEPLOY_DRIVER", "KELAY_LAMBDA_ROLE_ARN", "KELAY_SFN_ROLE_ARN", "APP_RESOURCE_PREFIX", "CONTROL_DATABASE_URL", "APP_DATABASE_URL_TEMPLATE", "APP_RUNTIME_DATA_API_URL"] :
      contains(keys(local.services["control-api"].env), name)
    ])
    error_message = "control-api is missing a setting the aws deploy driver or the database wiring reads."
  }

  assert {
    condition     = local.services["control-api"].env.KELAY_DEPLOY_DRIVER == "aws" && !contains(keys(local.services["control-api"].env), "KELAY_ROUTER_PRINCIPAL")
    error_message = "control-api must run the aws driver, without a Router principal (the Deploy role may not add resource policies)."
  }

  assert {
    condition = alltrue([
      for name in ["KELAY_ENV", "KELAY_ID_ISSUER", "KELAY_ID_JWKS_URL", "CONTROL_API_URL", "DATA_API_URL", "LLM_GATEWAY_URL", "MCP_PUBLIC_BASE_URL", "KELAY_APPS_SOURCE"] :
      contains(keys(local.shared_env), name)
    ])
    error_message = "A setting every service reads is missing from shared_env."
  }

  assert {
    condition     = local.shared_env.KELAY_APPS_SOURCE == "control-api"
    error_message = "Deployed services read apps from the control API; no image contains an apps file."
  }

  assert {
    condition = alltrue([
      for svc in ["control-api", "identity", "data-api"] :
      alltrue([for name in ["DB_USER", "DB_PASSWORD", "KELAY_CALLER_SECRET"] : contains(keys(local.services[svc].secrets), name)])
    ])
    error_message = "control-api, identity and data-api each need the platform database login and the caller secret."
  }

  assert {
    condition     = sort(keys(local.services["identity"].secrets)) == sort(["BETTER_AUTH_SECRET", "KELAY_CALLER_SECRET", "DB_USER", "DB_PASSWORD", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "KAKAO_CLIENT_ID", "KAKAO_CLIENT_SECRET"])
    error_message = "Kelay ID gets a client id and a client secret for each enabled provider, and nothing for the others."
  }

  assert {
    condition     = local.services["identity"].env.KELAY_ID_EMAIL_PASSWORD == "true" && local.services["identity"].env.KELAY_ID_CORS_ORIGINS == "https://console.kelay.example"
    error_message = "Kelay ID's email sign-in switch or its CORS origin is wrong."
  }

  assert {
    condition     = alltrue([for name in ["google-client-id", "google-client-secret", "kakao-client-id", "kakao-client-secret"] : contains(local.secret_names, name)]) && !contains(local.secret_names, "github-client-id")
    error_message = "Secret shells must exist for enabled providers only."
  }

  assert {
    condition     = alltrue([for name in ["DATABASE_HOST", "DATABASE_NAME"] : contains(keys(local.services["llm-gateway"].env), name)]) && alltrue([for name in ["DATABASE_USERNAME", "DATABASE_PASSWORD"] : contains(keys(local.services["llm-gateway"].secrets), name)]) && !contains(keys(local.services["llm-gateway"].secrets), "DATABASE_URL")
    error_message = "The LLM gateway takes its database login in parts, never as a URL with a password."
  }

  assert {
    condition = !anytrue([for name in local.secret_names : endswith(name, "database-url")]) && !anytrue(flatten([
      for svc, s in local.services : [for name in keys(lookup(s, "secrets", {})) : endswith(name, "DATABASE_URL")]
    ]))
    error_message = "Database URLs are plain settings without a login; no secret may hold one."
  }

  assert {
    condition     = local.services["preview-proxy"].desired_count == 0
    error_message = "preview-proxy has no image and must stay at zero tasks."
  }

  assert {
    condition     = local.services["otel-collector"].command == ["--config=/etc/otelcol-contrib/debug.yaml"] && length(local.services["otel-collector"].secrets) == 0
    error_message = "Without ClickHouse the collector runs its log-only pipeline and needs no secret."
  }
}

run "overrides_add_to_env" {
  command = plan

  variables {
    service_overrides = {
      "control-api" = { desired_count = 2, env = { LLM_MODEL = "claude-sonnet-5-5" } }
    }
  }

  assert {
    condition     = local.services["control-api"].env.LLM_MODEL == "claude-sonnet-5-5" && local.services["control-api"].env.KELAY_DEPLOY_DRIVER == "aws" && local.services["control-api"].desired_count == 2
    error_message = "An env override must add to the service's settings, not replace them."
  }

  assert {
    condition     = length(local.services["identity"].secrets) == 4 && local.services["identity"].env.KELAY_ID_EMAIL_PASSWORD == "false"
    error_message = "With no provider enabled Kelay ID gets no provider secrets, and email sign-in is off by default."
  }
}

run "clickhouse_collector" {
  command = plan

  variables {
    enable_clickhouse = true
  }

  assert {
    condition     = local.services["otel-collector"].command == null && contains(keys(local.services["otel-collector"].env), "CLICKHOUSE_ENDPOINT") && local.services["otel-collector"].secrets == { CLICKHOUSE_PASSWORD = "clickhouse-password" }
    error_message = "With ClickHouse the collector runs its default pipeline with the endpoint and the password."
  }
}
