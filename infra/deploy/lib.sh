# shellcheck shell=bash
# Shared by the scripts in this directory. Source it; do not run it.
# Every script prints the commands it would run. Only --execute runs them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC2034  # read by the scripts that source this file
DEPLOY_DIR="$ROOT/infra/deploy"
# shellcheck disable=SC2034
REGION="${AWS_REGION:-ap-northeast-2}"
EXECUTE=0

die() {
  echo "error: $*" >&2
  exit 1
}

note() {
  echo "# $*"
}

# Prints a command quoted so that it can be pasted into a shell, and runs it only with --execute.
run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [ "$EXECUTE" = 1 ]; then "$@"; fi
}

need_value() {
  [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
}

need_tool() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"
}

check_env() {
  case "${1:-}" in
    staging | prod) ;;
    *) die "--env must be staging or prod" ;;
  esac
}

# The account the commands target: --account or AWS_ACCOUNT_ID. With --execute and neither set, it asks
# AWS who the caller is (a read). A dry run without it prints a placeholder.
resolve_account() {
  if [ -z "${ACCOUNT:-}" ]; then
    if [ -n "${AWS_ACCOUNT_ID:-}" ]; then
      ACCOUNT="$AWS_ACCOUNT_ID"
    elif [ "$EXECUTE" = 1 ]; then
      need_tool aws
      ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
    else
      ACCOUNT='<aws-account-id>'
    fi
  fi
  case "$ACCOUNT" in
    '<aws-account-id>') ;;
    *[!0-9]* | '') die "the AWS account id must be 12 digits, got '$ACCOUNT'" ;;
  esac
}

# Refuses to change an account other than the one the operator named.
check_caller_account() {
  local caller
  need_tool aws
  caller="$(aws sts get-caller-identity --query Account --output text)"
  [ "$caller" = "$ACCOUNT" ] || die "the current AWS credentials are for account $caller, not $ACCOUNT"
}

dry_run_footer() {
  if [ "$EXECUTE" != 1 ]; then
    echo
    note "Dry run: nothing was changed. Add --execute to run the commands above."
  fi
}
