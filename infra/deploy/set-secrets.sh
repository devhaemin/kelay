#!/usr/bin/env bash
# Writes values into the Secrets Manager secrets Terraform created empty (kelay-<env>/<name>), from a
# local file of `name=value` lines. Copy secrets.env.example, fill it in, and keep it out of git
# (infra/deploy/.gitignore ignores *.env).
#
#   infra/deploy/set-secrets.sh --env staging --file infra/deploy/secrets.staging.env            # prints what it would set
#   infra/deploy/set-secrets.sh --env staging --file infra/deploy/secrets.staging.env --execute
#
# Options: --env staging|prod
#          --file <path>    lines of name=value; # starts a comment; a name with an empty value is skipped
#          --only <name>    (repeatable) set just these names
#          --account <id>   (default: AWS_ACCOUNT_ID, or the caller's account with --execute)
#          --region <r>     (default: AWS_REGION or ap-northeast-2)
#
# A value is everything after the first "=", taken as written: no quotes, no escapes. Values are never
# printed, and they reach the AWS CLI through a private temporary file, not the command line.
# shellcheck source=infra/deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV_NAME=''
FILE=''
ACCOUNT=''
ONLY=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env) need_value "$@"; ENV_NAME="$2"; shift 2 ;;
    --file) need_value "$@"; FILE="$2"; shift 2 ;;
    --only) need_value "$@"; ONLY+=("$2"); shift 2 ;;
    --account) need_value "$@"; ACCOUNT="$2"; shift 2 ;;
    --region) need_value "$@"; REGION="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

check_env "$ENV_NAME"
[ -n "$FILE" ] || die "--file is required"
[ -f "$FILE" ] || die "$FILE does not exist"
resolve_account

tmp=''
cleanup() { if [ -n "$tmp" ]; then rm -f "$tmp"; fi; }
trap cleanup EXIT
if [ "$EXECUTE" = 1 ]; then
  check_caller_account
  umask 077
  tmp="$(mktemp)"
fi

wanted() {
  [ ${#ONLY[@]} -eq 0 ] && return 0
  local name
  for name in "${ONLY[@]}"; do [ "$name" = "$1" ] && return 0; done
  return 1
}

note "Secrets of kelay-$ENV_NAME in $REGION (account $ACCOUNT), from $FILE"
set_count=0
line_number=0
while IFS= read -r line || [ -n "$line" ]; do
  line_number=$((line_number + 1))
  case "$line" in '' | '#'*) continue ;; esac
  case "$line" in *=*) ;; *) die "$FILE:$line_number: expected name=value" ;; esac
  name="${line%%=*}"
  value="${line#*=}"
  [[ "$name" =~ ^[a-z][a-z0-9-]*$ ]] || die "$FILE:$line_number: '$name' is not a secret name (lowercase letters, digits and dashes)"
  wanted "$name" || continue
  if [ -z "$value" ]; then
    note "$name: no value in the file; skipped."
    continue
  fi
  # The services refuse a shorter caller secret (data-api, mcp-gateway), and it signs every caller token.
  if [ "$name" = kelay-caller-secret ] && [ ${#value} -lt 32 ]; then
    die "$FILE:$line_number: kelay-caller-secret must be at least 32 characters"
  fi
  echo "+ aws secretsmanager put-secret-value --region $REGION --secret-id kelay-$ENV_NAME/$name --secret-string <${#value} characters>"
  if [ "$EXECUTE" = 1 ]; then
    printf '%s' "$value" >"$tmp"
    aws secretsmanager put-secret-value --region "$REGION" --secret-id "kelay-$ENV_NAME/$name" \
      --secret-string "file://$tmp" --query VersionId --output text
  fi
  set_count=$((set_count + 1))
done <"$FILE"

echo
note "$set_count secret(s). ECS reads a secret when a task starts: restart a service to pick up a new value"
note "(aws ecs update-service --cluster kelay-$ENV_NAME --service <service> --force-new-deployment)."
dry_run_footer
