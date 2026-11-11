data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  partition = data.aws_partition.current.partition
  region    = data.aws_region.current.region
  account   = data.aws_caller_identity.current.account_id
  prefix    = var.app_resource_prefix

  function_arns = [
    "arn:${local.partition}:lambda:${local.region}:${local.account}:function:${local.prefix}*",
    "arn:${local.partition}:lambda:${local.region}:${local.account}:function:${local.prefix}*:*",
  ]
  state_machine_arn       = "arn:${local.partition}:states:${local.region}:${local.account}:stateMachine:${local.prefix}*"
  state_machine_qualified = "arn:${local.partition}:states:${local.region}:${local.account}:stateMachine:${local.prefix}*:*"
  execution_arns = [
    "arn:${local.partition}:states:${local.region}:${local.account}:execution:${local.prefix}*:*",
    "arn:${local.partition}:states:${local.region}:${local.account}:express:${local.prefix}*:*:*",
  ]
  lambda_log_groups = [
    "arn:${local.partition}:logs:${local.region}:${local.account}:log-group:/aws/lambda/${local.prefix}*",
    "arn:${local.partition}:logs:${local.region}:${local.account}:log-group:/aws/lambda/${local.prefix}*:*",
  ]
  states_log_groups = [
    "arn:${local.partition}:logs:${local.region}:${local.account}:log-group:/aws/vendedlogs/states/${local.prefix}*",
    "arn:${local.partition}:logs:${local.region}:${local.account}:log-group:/aws/vendedlogs/states/${local.prefix}*:*",
  ]
  app_role_arn = "arn:${local.partition}:iam::${local.account}:role/${local.prefix}*"

  # Every per-app resource carries these tags; the Deploy service may only create and change tagged
  # ones. kelay:env is the platform env (this one), not the app's: the app's dev or prod env is in
  # the resource name and in kelay:app-env. services/control-api/src/deploy/aws.ts sets all four.
  required_tags = {
    "kelay:env"        = var.env
    "kelay:managed-by" = "kelay-deploy"
  }
  protected_tag_keys = concat(keys(local.required_tags), ["kelay:app", "kelay:app-env"])
}

################################################################################
# Permissions boundary: the most any per-app role can ever do
################################################################################

data "aws_iam_policy_document" "boundary" {
  statement {
    sid       = "AppLogs"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = local.lambda_log_groups
  }

  statement {
    sid       = "InvokeAppFunctions"
    actions   = ["lambda:InvokeFunction"]
    resources = local.function_arns
  }

  statement {
    sid = "StatesLogDelivery"
    actions = [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "Tracing"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "boundary" {
  name        = var.boundary_name
  description = "Permissions boundary for Kelay per-app roles (${var.env}): logs, invoke kelay-app functions, tracing."
  policy      = data.aws_iam_policy_document.boundary.json
  tags        = var.tags
}

################################################################################
# Shared execution role for every per-app Lambda: logs only
################################################################################

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "lambda_exec" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = local.lambda_log_groups
  }
}

# Shared roles are named outside the per-app prefix so per-app role grants can never touch them.
resource "aws_iam_role" "lambda_exec" {
  name                 = "${var.name}-app-lambda"
  description          = "Shared execution role for Kelay per-app Lambda functions (${var.env}). Logs only."
  assume_role_policy   = data.aws_iam_policy_document.lambda_trust.json
  permissions_boundary = aws_iam_policy.boundary.arn
  tags                 = var.tags
}

resource "aws_iam_role_policy" "lambda_exec" {
  name   = "logs"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.lambda_exec.json
}

################################################################################
# Step Functions execution role: invoke kelay-app-* node functions
################################################################################

data "aws_iam_policy_document" "states_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.state_machine_arn, local.state_machine_qualified]
    }
  }
}

data "aws_iam_policy_document" "states_exec" {
  statement {
    sid       = "InvokeNodes"
    actions   = ["lambda:InvokeFunction"]
    resources = local.function_arns
  }

  statement {
    sid = "LogDelivery"
    actions = [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "Tracing"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"]
    resources = ["*"]
  }
}

resource "aws_iam_role" "states_exec" {
  name                 = "${var.name}-app-states"
  description          = "Shared Step Functions execution role for Kelay agent graphs (${var.env})."
  assume_role_policy   = data.aws_iam_policy_document.states_trust.json
  permissions_boundary = aws_iam_policy.boundary.arn
  tags                 = var.tags
}

resource "aws_iam_role_policy" "states_exec" {
  name   = "invoke-nodes"
  role   = aws_iam_role.states_exec.id
  policy = data.aws_iam_policy_document.states_exec.json
}

################################################################################
# Deploy service task role (runs inside control-api)
################################################################################

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account]
    }
  }
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "CreateTaggedFunctions"
    actions   = ["lambda:CreateFunction", "lambda:TagResource"]
    resources = local.function_arns

    dynamic "condition" {
      for_each = local.required_tags
      content {
        test     = "StringEquals"
        variable = "aws:RequestTag/${condition.key}"
        values   = [condition.value]
      }
    }

    condition {
      test     = "Null"
      variable = "aws:RequestTag/kelay:app"
      values   = ["false"]
    }
  }

  # Reads carry no tag condition. A function that does not exist yet has no tags, so a conditioned
  # read would be refused as access denied, and the Deploy service could not tell "missing" (create
  # it) from "forbidden". The name prefix still limits what can be read.
  statement {
    sid = "ReadAppFunctions"
    actions = [
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
      "lambda:ListVersionsByFunction",
      "lambda:GetAlias",
      "lambda:ListAliases",
      "lambda:ListTags",
      "lambda:GetFunctionUrlConfig",
      "lambda:GetProvisionedConcurrencyConfig",
    ]
    resources = local.function_arns
  }

  statement {
    sid = "ManageOwnFunctions"
    actions = [
      "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration",
      "lambda:PublishVersion",
      "lambda:CreateAlias",
      "lambda:UpdateAlias",
      "lambda:DeleteAlias",
      "lambda:DeleteFunction",
      "lambda:InvokeFunction",
      "lambda:DeleteFunctionUrlConfig",
      "lambda:PutFunctionConcurrency",
      "lambda:DeleteFunctionConcurrency",
      "lambda:PutProvisionedConcurrencyConfig",
      "lambda:DeleteProvisionedConcurrencyConfig",
      "lambda:PutFunctionEventInvokeConfig",
      "lambda:DeleteFunctionEventInvokeConfig",
    ]
    resources = local.function_arns

    dynamic "condition" {
      for_each = local.required_tags
      content {
        test     = "StringEquals"
        variable = "aws:ResourceTag/${condition.key}"
        values   = [condition.value]
      }
    }
  }

  statement {
    sid       = "IamAuthFunctionUrlsOnly"
    actions   = ["lambda:CreateFunctionUrlConfig", "lambda:UpdateFunctionUrlConfig"]
    resources = local.function_arns

    condition {
      test     = "StringEquals"
      variable = "lambda:FunctionUrlAuthType"
      values   = ["AWS_IAM"]
    }

    dynamic "condition" {
      for_each = local.required_tags
      content {
        test     = "StringEquals"
        variable = "aws:ResourceTag/${condition.key}"
        values   = [condition.value]
      }
    }
  }

  statement {
    sid       = "DenyPublicFunctionUrls"
    effect    = "Deny"
    actions   = ["lambda:CreateFunctionUrlConfig", "lambda:UpdateFunctionUrlConfig"]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "lambda:FunctionUrlAuthType"
      values   = ["AWS_IAM"]
    }
  }

  # The Router calls function URLs with its own IAM policy (same account), so no function needs a
  # resource policy, and the Deploy service must not be able to open one to anyone else.
  statement {
    sid       = "DenyResourcePolicies"
    effect    = "Deny"
    actions   = ["lambda:AddPermission", "lambda:RemovePermission"]
    resources = ["*"]
  }

  statement {
    sid       = "DenyVpcAttachedFunctions"
    effect    = "Deny"
    actions   = ["lambda:CreateFunction", "lambda:UpdateFunctionConfiguration"]
    resources = ["*"]

    condition {
      test     = "Null"
      variable = "lambda:VpcIds"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyProtectedTagChanges"
    effect    = "Deny"
    actions   = ["lambda:UntagResource", "states:UntagResource"]
    resources = ["*"]

    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "aws:TagKeys"
      values   = local.protected_tag_keys
    }
  }

  statement {
    sid       = "ReadLambdaAccount"
    actions   = ["lambda:ListFunctions", "lambda:GetAccountSettings", "states:ListStateMachines", "states:ValidateStateMachineDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "PassLambdaRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.lambda_exec.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }

  statement {
    sid       = "PassStatesRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.states_exec.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["states.amazonaws.com"]
    }
  }

  # Publishing is here too: the Deploy service creates a state machine and its first version in one call.
  statement {
    sid       = "CreateTaggedStateMachines"
    actions   = ["states:CreateStateMachine", "states:TagResource", "states:PublishStateMachineVersion"]
    resources = [local.state_machine_arn]

    dynamic "condition" {
      for_each = local.required_tags
      content {
        test     = "StringEquals"
        variable = "aws:RequestTag/${condition.key}"
        values   = [condition.value]
      }
    }

    condition {
      test     = "Null"
      variable = "aws:RequestTag/kelay:app"
      values   = ["false"]
    }
  }

  # Untagged for the same reason as ReadAppFunctions: the Deploy service describes a state machine
  # to learn whether it has to create it.
  statement {
    sid = "ReadAppStateMachines"
    actions = [
      "states:DescribeStateMachine",
      "states:ListStateMachineVersions",
      "states:ListTagsForResource",
    ]
    resources = [local.state_machine_arn, local.state_machine_qualified]
  }

  statement {
    sid = "ManageOwnStateMachines"
    actions = [
      "states:UpdateStateMachine",
      "states:DeleteStateMachine",
      "states:PublishStateMachineVersion",
    ]
    resources = [local.state_machine_arn]

    dynamic "condition" {
      for_each = local.required_tags
      content {
        test     = "StringEquals"
        variable = "aws:ResourceTag/${condition.key}"
        values   = [condition.value]
      }
    }
  }

  statement {
    sid = "ManageStateMachineAliasesAndVersions"
    actions = [
      "states:CreateStateMachineAlias",
      "states:UpdateStateMachineAlias",
      "states:DeleteStateMachineAlias",
      "states:DescribeStateMachineAlias",
      "states:ListStateMachineAliases",
      "states:DeleteStateMachineVersion",
    ]
    resources = [local.state_machine_arn, local.state_machine_qualified]
  }

  statement {
    sid = "AppLogGroups"
    actions = [
      "logs:CreateLogGroup",
      "logs:PutRetentionPolicy",
      "logs:DeleteLogGroup",
      "logs:TagResource",
      "logs:ListTagsForResource",
    ]
    resources = concat(local.lambda_log_groups, local.states_log_groups)
  }

  statement {
    sid       = "DescribeLogGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  statement {
    sid       = "BuildBundles"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]
    resources = ["${var.artifacts_bucket_arn}/builds/*"]
  }

  statement {
    sid       = "ListBuildBundles"
    actions   = ["s3:ListBucket"]
    resources = [var.artifacts_bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["builds/*"]
    }
  }

  dynamic "statement" {
    for_each = var.allow_per_app_roles ? [1] : []
    content {
      sid = "CreateBoundedAppRoles"
      actions = [
        "iam:CreateRole",
        "iam:PutRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:DetachRolePolicy",
        "iam:TagRole",
      ]
      resources = [local.app_role_arn]

      condition {
        test     = "StringEquals"
        variable = "iam:PermissionsBoundary"
        values   = [aws_iam_policy.boundary.arn]
      }
    }
  }

  dynamic "statement" {
    for_each = var.allow_per_app_roles ? [1] : []
    content {
      sid       = "ManageAppRoles"
      actions   = ["iam:GetRole", "iam:DeleteRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies"]
      resources = [local.app_role_arn]
    }
  }

  dynamic "statement" {
    for_each = var.allow_per_app_roles ? [1] : []
    content {
      sid       = "PassAppRoles"
      actions   = ["iam:PassRole"]
      resources = [local.app_role_arn]

      condition {
        test     = "StringEquals"
        variable = "iam:PassedToService"
        values   = ["lambda.amazonaws.com", "states.amazonaws.com"]
      }
    }
  }

  statement {
    sid       = "KeepBoundary"
    effect    = "Deny"
    actions   = ["iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary", "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:SetDefaultPolicyVersion"]
    resources = ["*"]
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.name}-deploy"
  description        = "Kelay ${var.env} Deploy service: manages tagged ${local.prefix}* functions and state machines only."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy-app-runtime"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

################################################################################
# Run orchestrator: start and watch agent-graph executions (attach to whichever service runs it)
################################################################################

data "aws_iam_policy_document" "orchestrator" {
  statement {
    sid       = "StartRuns"
    actions   = ["states:StartExecution", "states:StartSyncExecution"]
    resources = [local.state_machine_arn, local.state_machine_qualified]
  }

  statement {
    sid       = "WatchRuns"
    actions   = ["states:DescribeExecution", "states:StopExecution", "states:GetExecutionHistory", "states:DescribeStateMachineForExecution"]
    resources = local.execution_arns
  }

  statement {
    sid       = "ListRuns"
    actions   = ["states:ListExecutions"]
    resources = [local.state_machine_arn, local.state_machine_qualified]
  }
}

resource "aws_iam_policy" "orchestrator" {
  name        = "${var.name}-run-orchestrator"
  description = "Start and observe Kelay agent-graph runs (${var.env})."
  policy      = data.aws_iam_policy_document.orchestrator.json
  tags        = var.tags
}

################################################################################
# Cloudflare Router identity: SigV4-signed calls to IAM-auth function URLs
################################################################################

data "aws_iam_policy_document" "router" {
  statement {
    sid       = "InvokeFunctionUrls"
    actions   = ["lambda:InvokeFunctionUrl"]
    resources = local.function_arns

    condition {
      test     = "StringEquals"
      variable = "lambda:FunctionUrlAuthType"
      values   = ["AWS_IAM"]
    }
  }

  # Since October 2025 a function URL call also needs lambda:InvokeFunction; scope it to URL calls.
  statement {
    sid       = "InvokeViaFunctionUrlOnly"
    actions   = ["lambda:InvokeFunction"]
    resources = local.function_arns

    condition {
      test     = "Bool"
      variable = "lambda:InvokedViaFunctionUrl"
      values   = ["true"]
    }
  }
}

resource "aws_iam_user" "router" {
  name = "${var.name}-router"
  path = "/kelay/"
  tags = merge(var.tags, { "kelay:purpose" = "cloudflare-router" })
}

resource "aws_iam_user_policy" "router" {
  name   = "invoke-app-function-urls"
  user   = aws_iam_user.router.name
  policy = data.aws_iam_policy_document.router.json
}

resource "aws_iam_access_key" "router" {
  count = var.create_router_access_key ? 1 : 0
  user  = aws_iam_user.router.name
}
