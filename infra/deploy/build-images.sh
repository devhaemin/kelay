#!/usr/bin/env bash
# Builds the service images listed in images.json for the Fargate tasks' architecture and, with --push,
# pushes them to the env's ECR repositories (<account>.dkr.ecr.<region>.amazonaws.com/kelay-<env>/<service>).
# The repositories are tag-immutable, so a tag that is already there is skipped, not overwritten.
#
#   infra/deploy/build-images.sh --env staging                    # prints the builds
#   infra/deploy/build-images.sh --env staging --execute          # builds locally, pushes nothing
#   infra/deploy/build-images.sh --env staging --account 111111111111 --push --execute
#
# Options: --env staging|prod
#          --tag <tag>       (default: the 12-character git commit; refused with --push on a dirty tree)
#          --service <name>  (repeatable; default: every image in images.json)
#          --account <id>    (default: AWS_ACCOUNT_ID, or the caller's account with --execute; needed for --push)
#          --region <r>      (default: AWS_REGION or ap-northeast-2)
#          --platform <p>    (default: linux/amd64)
#          --push            also push; without it the images stay local as kelay-<env>/<service>:<tag>
# shellcheck source=infra/deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENV_NAME=''
TAG=''
ACCOUNT=''
PLATFORM='linux/amd64'
PUSH=0
SERVICES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env) need_value "$@"; ENV_NAME="$2"; shift 2 ;;
    --tag) need_value "$@"; TAG="$2"; shift 2 ;;
    --service) need_value "$@"; SERVICES+=("$2"); shift 2 ;;
    --account) need_value "$@"; ACCOUNT="$2"; shift 2 ;;
    --region) need_value "$@"; REGION="$2"; shift 2 ;;
    --platform) need_value "$@"; PLATFORM="$2"; shift 2 ;;
    --push) PUSH=1; shift ;;
    --execute) EXECUTE=1; shift ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

check_env "$ENV_NAME"
need_tool jq
cd "$ROOT"

if [ -z "$TAG" ]; then
  TAG="$(git rev-parse --short=12 HEAD)"
  if [ "$PUSH" = 1 ] && [ -n "$(git status --porcelain)" ]; then
    die "the working tree has uncommitted changes, so commit $TAG does not describe it; commit first or pass --tag"
  fi
fi
[[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "'$TAG' is not a valid image tag"

if [ "$PUSH" = 1 ]; then
  resolve_account
  PREFIX="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/kelay-$ENV_NAME"
else
  PREFIX="kelay-$ENV_NAME"
fi

known="$(jq -r '.[].service' "$DEPLOY_DIR/images.json")"
if [ ${#SERVICES[@]} -eq 0 ]; then
  while IFS= read -r service; do SERVICES+=("$service"); done <<<"$known"
fi
for service in "${SERVICES[@]}"; do
  grep -qx -- "$service" <<<"$known" || die "no image for '$service' in infra/deploy/images.json (it has: $(tr '\n' ' ' <<<"$known"))"
done

if [ "$PUSH" = 1 ]; then
  echo "+ aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin ${PREFIX%%/*}"
  if [ "$EXECUTE" = 1 ]; then
    check_caller_account
    aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${PREFIX%%/*}"
  fi
fi

for service in "${SERVICES[@]}"; do
  context="$(jq -r --arg s "$service" '.[] | select(.service == $s) | .context' "$DEPLOY_DIR/images.json")"
  dockerfile="$(jq -r --arg s "$service" '.[] | select(.service == $s) | .dockerfile' "$DEPLOY_DIR/images.json")"
  image="$PREFIX/$service:$TAG"
  echo
  if [ "$PUSH" = 1 ] && [ "$EXECUTE" = 1 ] &&
    aws ecr describe-images --region "$REGION" --repository-name "kelay-$ENV_NAME/$service" --image-ids "imageTag=$TAG" >/dev/null 2>&1; then
    note "$image is in ECR already; skipped."
    continue
  fi
  run docker build --platform "$PLATFORM" -f "$dockerfile" -t "$image" "$context"
  if [ "$PUSH" = 1 ]; then run docker push "$image"; fi
done

echo
note "Image tag: $TAG"
note "Render the Terraform var file for it: node infra/deploy/render-services.mjs --env $ENV_NAME --tag $TAG"
dry_run_footer
