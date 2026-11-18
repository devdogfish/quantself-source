#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${QUANTSELF_DEPLOY_OWNER:-}" != "github-actions" ]]; then
  echo "Production deploy rejected: GitHub Actions is the only production deploy owner." >&2
  exit 1
fi

if [[ "${QUANTSELF_DEPLOY_TARGET:-}" != home ]]; then
  echo "Current releases deploy to Keep. Use the retained release and rollback procedure for Hostinger." >&2
  exit 1
fi

if [[ -e /var/lib/quantself-release/pending || -e /var/lib/quantself-release/active ]]; then
  echo "Keep has release slot state. Use the staged promotion or rollback path." >&2
  exit 1
fi

if [[ "$#" -ne 5 ]]; then
  echo "Usage: deploy-production.sh DEPLOY_PATH PROXY_NETWORK REPOSITORY_URL DEPLOY_SHA PRODUCTION_URL" >&2
  exit 1
fi

deploy_path="$1"
proxy_network="$2"
deploy_sha="$4"
production_url="$5"
if [[ "${production_url%/}" != https://qs.girke.dev ]]; then
  echo "Keep deployment requires the approved production origin." >&2
  exit 1
fi

compose_base="compose.yaml"
compose_production="compose.prod.yaml"
compose=(docker compose -f "$compose_base" -f "$compose_production" -f compose.home.yaml)
if [[ -z "${QUANTSELF_IMAGE_ARCHIVE:-}" || ! "${QUANTSELF_IMAGE_ID:-}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Home deployment requires the exact verified image archive and ID." >&2
  exit 1
fi
# Override a profile inherited from the environment or the project .env.
export COMPOSE_PROFILES=""

cd "$deploy_path"

# The home dispatcher fetches main under the production lock before invoking this script.
remote_main_sha="$(git rev-parse FETCH_HEAD)"
if [[ "$remote_main_sha" != "$deploy_sha" ]]; then
  echo "Obsolete deploy rejected: requested $deploy_sha; origin/main is $remote_main_sha." >&2
  exit 1
fi

git checkout -B main "$deploy_sha"
git reset --hard "$deploy_sha"

if [[ "$(git rev-parse HEAD)" != "$deploy_sha" ]]; then
  echo "Checked-out revision does not match workflow revision $deploy_sha." >&2
  exit 1
fi

wait_for_service() {
  local service="$1"
  local deadline=$((SECONDS + 180))
  local container_id
  local health
  local status

  while ((SECONDS < deadline)); do
    container_id="$("${compose[@]}" ps --quiet "$service")"
    if [[ -n "$container_id" ]]; then
      status="$(docker inspect --format '{{.State.Status}}' "$container_id")"
      health="$(
        docker inspect \
          --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
          "$container_id"
      )"
      if [[ "$status" == "running" && "$health" != "starting" && "$health" != "unhealthy" ]]; then
        return 0
      fi
    fi
    sleep 3
  done

  echo "Production service did not become healthy: $service" >&2
  return 1
}

if [[ -n "$proxy_network" ]]; then
  docker network inspect "$proxy_network" >/dev/null
fi
./scripts/check-inventory-worker-config.sh .env
./scripts/check-api-foundation-config.sh .env
"${compose[@]}" config --quiet
"${compose[@]}" config --format json | jq --exit-status \
  --arg origin "${production_url%/}" '
    .services |
    ([.app.environment, .api.environment] |
      all((.QUANTSELF_PUBLIC_ORIGIN | rtrimstr("/")) == $origin and
          (.QUANTSELF_OWNER_INGRESS_TOKEN | test("^[0-9a-f]{64}$")))) and
    (.api.environment |
      [.QUANTSELF_WEBSITE_ANALYTICS_INGEST_TOKEN, .QUANTSELF_TRACKED_LINKS_READ_TOKEN,
       .QUANTSELF_TRACKED_LINKS_APPLICATION_TOKEN, .QUANTSELF_TRACKED_LINKS_SHARE_TOKEN] |
      all(type == "string" and test("^[!-~]{32,}$")) and (unique | length) == length)
  ' >/dev/null

echo "Loading verified production candidate $deploy_sha."
docker load --input "$QUANTSELF_IMAGE_ARCHIVE"
image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$QUANTSELF_IMAGE_ID")"
if [[ "$image_revision" != "$deploy_sha" ]]; then
  echo "Candidate image revision does not match $deploy_sha." >&2
  exit 1
fi
docker image tag "$QUANTSELF_IMAGE_ID" quantself-app

echo "Checking private Jobs mounts in the approved candidate before database migration."
check_jobs_mount='
  case "$1" in
    api) path="${QUANTSELF_JOBS_EMAIL_ROUTES:?}" ;;
    app) path="${QUANTSELF_JOBS_HOME:?}/candidate-rules.json" ;;
  esac
  test -f "$path" && test ! -L "$path" && test -r "$path" && : < "$path"
'
for service in api app; do
  if ! "${compose[@]}" run --rm --no-deps --pull never --interactive=false --no-TTY \
    --entrypoint sh "$service" -ec "$check_jobs_mount" sh "$service" </dev/null >/dev/null; then
    echo "Private Jobs mount is missing or unreadable by the $service runtime." >&2
    exit 1
  fi
done
if ! "${compose[@]}" run --rm --no-deps --pull never --interactive=false --no-TTY \
  --entrypoint bun api scripts/check-jobs-resume-templates.ts </dev/null >/dev/null; then
  echo "Stage the three private Jobs résumé templates before migration." >&2
  exit 1
fi

echo "Checking candidate worker credentials before database migration."
"${compose[@]}" run --rm --no-deps --interactive=false \
  --entrypoint /app/apps/web/node_modules/.bin/codex \
  inventory-codex-enrichment-worker login status >/dev/null

if [[ -z "$("${compose[@]}" ps --quiet postgres)" ]]; then
  echo "Starting production PostgreSQL before database migration."
  "${compose[@]}" up --detach --no-build postgres
fi
wait_for_service postgres

echo "Applying production migrations while current application containers remain running."
"${compose[@]}" up \
  --no-build \
  --no-deps \
  --force-recreate \
  --abort-on-container-exit \
  --exit-code-from migrate \
  migrate

echo "Promoting the built candidate."
"${compose[@]}" stop inventory-preprocessing-worker
"${compose[@]}" up --detach --no-build --remove-orphans
"${compose[@]}" up --no-start --no-deps --no-build --force-recreate inventory-preprocessing-worker

production_services=(
  app
  api
  gateway
  inventory-codex-enrichment-worker
)
for service in "${production_services[@]}"; do
  wait_for_service "$service"
done

COMPOSE_FILE="$compose_base:$compose_production:compose.home.yaml" ./scripts/check-inventory-workers.sh
bash scripts/smoke-production.sh "$production_url"

"${compose[@]}" ps --all
echo "Production deploy complete: $deploy_sha"
