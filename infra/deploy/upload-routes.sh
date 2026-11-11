#!/usr/bin/env bash
# Uploads app routes to the Router Worker's ROUTES namespace in Workers KV. The Router looks up
# `app:<handle>/<app>` there to find where /<handle>/<app> is served (services/router/src/routes.ts).
#
#   infra/deploy/upload-routes.sh --namespace-id <id> --file infra/deploy/routes.example.json            # prints the entries
#   infra/deploy/upload-routes.sh --namespace-id <id> --file infra/deploy/out/staging/routes.json --execute
#
# Options: --namespace-id <id>  from `terraform output -raw routes_kv_namespace_id`
#          --file <path>        JSON: { "<handle>/<app>": { "prod": { "origin", "region"? }, "dev"?: { ... } } }
#
# With --execute it needs CLOUDFLARE_API_TOKEN (Workers KV Storage: Edit) and CLOUDFLARE_ACCOUNT_ID in the
# environment. Entries are written, never deleted: to take an app offline, delete its key with
# `wrangler kv key delete "app:<handle>/<app>" --namespace-id <id> --remote`.
# shellcheck source=infra/deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

NAMESPACE=''
FILE=''
while [ $# -gt 0 ]; do
  case "$1" in
    --namespace-id) need_value "$@"; NAMESPACE="$2"; shift 2 ;;
    --file) need_value "$@"; FILE="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

need_tool jq
[[ "$NAMESPACE" =~ ^[0-9a-f]{32}$ ]] || die "--namespace-id must be the 32-character id of the ROUTES namespace"
[ -n "$FILE" ] || die "--file is required"
[ -f "$FILE" ] || die "$FILE does not exist"

# The same rules as AppRoute in services/router/src/routes.ts: the Router answers 500 for an entry it cannot parse.
problems="$(jq -r '
  def slug: type == "string" and test("^[a-z][a-z0-9-]{1,62}$");
  def target: type == "object" and (.origin | type == "string" and test("^https?://[^/ ]+"))
    and ((.region // "ap-northeast-2") | type == "string" and test("^[a-z]{2}(-[a-z]+)+-[0-9]+$"))
    and (keys - ["origin", "region"] == []);
  if type != "object" then "the file must hold one JSON object" else
    to_entries[] | .key as $k | .value as $v
    | if ($k | split("/") | length == 2 and all(.[]; slug)) | not then "\($k): the key must be <handle>/<app>"
      elif ($v | type) != "object" or ($v | keys - ["prod", "dev"] != []) then "\($k): the value takes prod and dev only"
      elif ($v.prod | target) | not then "\($k): prod needs an http(s) origin, and a region like ap-northeast-2 if it has one"
      elif ($v | has("dev")) and (($v.dev | target) | not) then "\($k): dev needs an http(s) origin, and a region like ap-northeast-2 if it has one"
      else empty end
  end' "$FILE")" || die "$FILE is not valid JSON"
[ -z "$problems" ] || die "$FILE:
$problems"

count="$(jq 'length' "$FILE")"
[ "$count" -gt 0 ] || die "$FILE has no routes"

bulk="$(mktemp)"
trap 'rm -f "$bulk"' EXIT
jq 'to_entries | map({ key: ("app:" + .key), value: (.value | tojson) })' "$FILE" >"$bulk"

note "$count route(s) for KV namespace $NAMESPACE:"
jq -r '.[] | "#   \(.key) = \(.value)"' "$bulk"
echo
if [ "$EXECUTE" = 1 ]; then
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN is not set"
  [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is not set"
fi
cd "$ROOT"
run pnpm --filter @kelay/router exec wrangler kv bulk put "$bulk" --namespace-id "$NAMESPACE" --remote
note "The Router caches a route for 60 seconds, so a changed origin takes up to a minute to apply."
dry_run_footer
