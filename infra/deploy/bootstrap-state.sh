#!/usr/bin/env bash
# Creates the Terraform state bucket of an AWS account (infra/terraform/README.md, "Bootstrap"):
# versioned, encrypted, private. One bucket per account holds the state of the env in that account.
#
#   infra/deploy/bootstrap-state.sh --account 111111111111            # prints the commands
#   infra/deploy/bootstrap-state.sh --account 111111111111 --execute  # runs them
#
# Options: --account <id>  (default: AWS_ACCOUNT_ID, or the caller's account with --execute)
#          --bucket <name> (default: kelay-tfstate-<account>)
#          --region <r>    (default: AWS_REGION or ap-northeast-2)
# shellcheck source=infra/deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ACCOUNT=''
BUCKET=''
while [ $# -gt 0 ]; do
  case "$1" in
    --account) need_value "$@"; ACCOUNT="$2"; shift 2 ;;
    --bucket) need_value "$@"; BUCKET="$2"; shift 2 ;;
    --region) need_value "$@"; REGION="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

resolve_account
BUCKET="${BUCKET:-kelay-tfstate-$ACCOUNT}"
note "State bucket s3://$BUCKET in $REGION (account $ACCOUNT)"

exists=0
if [ "$EXECUTE" = 1 ]; then
  check_caller_account
  if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then exists=1; fi
fi
if [ "$exists" = 1 ]; then
  note "The bucket exists already; its settings are applied again."
else
  run aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION"
fi
run aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
run aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
run aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

echo
note "Next, in infra/terraform/envs/<env>:"
note "  echo 'bucket = \"$BUCKET\"' > backend.hcl && terraform init -backend-config=backend.hcl"
dry_run_footer
