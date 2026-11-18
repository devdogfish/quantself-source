#!/usr/bin/env bash
set -euo pipefail

image=${1:?Expected an image tag}
revision=${2:?Expected an image revision}
[[ "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$revision" ]]

# Read the deployed command and PATH without loading any project .env file.
home_worker=$(
  DATABASE_URL=postgresql://fixture:fixture@postgres:5432/fixture \
  QUANTSELF_PUBLIC_ORIGIN=http://localhost:3000 \
  QUANTSELF_INSTANCE_NAME=image-smoke QUANTSELF_OWNER_EMAIL=owner@example.test \
  INVENTORY_PREPROCESSING_WORKER_SECRET=image-smoke-worker \
  INVENTORY_ENRICHMENT_WORKER_SECRET=image-smoke-worker \
  QUANTSELF_OWNER_INGRESS_TOKEN=$(printf "a%.0s" {1..64}) \
  QUANTSELF_OPENCLOUD_URL=https://opencloud.example.test QUANTSELF_OPENCLOUD_SPACE_ID=fixture \
  QUANTSELF_OPENCLOUD_USERNAME=fixture QUANTSELF_OPENCLOUD_TOKEN=fixture \
  docker compose --env-file /dev/null -f compose.yaml -f compose.prod.yaml -f compose.home.yaml \
    config --format json | jq -e '.services["inventory-codex-enrichment-worker"]'
)
worker_path=$(jq -er '.environment.PATH' <<< "$home_worker")
worker_command=()
while IFS= read -r arg; do
  worker_command+=("$arg")
done < <(jq -er '.command[]' <<< "$home_worker")
docker run --rm --network none -e "PATH=$worker_path" -e CODEX_HOME=/codex-home \
  -e INVENTORY_ENRICHMENT_WORKER_BASE_URL=http://api:3001 \
  -e INVENTORY_ENRICHMENT_WORKER_SECRET=image-smoke-worker \
  "$image" sh -ec '
    mkdir -p "$CODEX_HOME"
    status=0
    output=$(codex login status 2>&1) || status=$?
    printf "%s\n" "$output"
    test "$status" = 1
    printf "%s\n" "$output" | grep -Fxq "Not logged in"

    status=0
    output=$("$@" --once 2>&1) || status=$?
    printf "%s\n" "$output"
    test "$status" = 1
    printf "%s\n" "$output" | grep -Fxq "Codex authentication is required before the inventory enrichment worker can start."
  ' sh "${worker_command[@]}"

suffix=${GITHUB_RUN_ID:-$$}
network="qs-image-smoke-$suffix"
db="$network-db"
web="$network-web"
api="$network-api"
cleanup() {
  local status=$?
  if [[ "$status" != 0 ]]; then
    for container in "$db" "$web" "$api"; do docker logs --tail 40 "$container" >&2 || true; done
  fi
  docker rm -f "$db" "$web" "$api" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$network" >/dev/null
docker run -d --name "$db" --network "$network" \
  -e POSTGRES_USER=fixture -e POSTGRES_PASSWORD=fixture -e POSTGRES_DB=fixture postgres:18-alpine >/dev/null
ready=0
for attempt in {1..30}; do
  if docker exec "$db" pg_isready -h 127.0.0.1 -U fixture -d fixture >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = 1

proof=$(printf "a%.0s" {1..64})
environment=(
  --network "$network"
  -e "DATABASE_URL=postgresql://fixture:fixture@$db:5432/fixture"
  -e BETTER_AUTH_SECRET=synthetic-image-smoke-no-production-secrets
  -e QUANTSELF_PUBLIC_ORIGIN=http://localhost:3000
  -e "QUANTSELF_OWNER_INGRESS_TOKEN=$proof"
  -e QUANTSELF_OWNER_EMAIL=owner@example.test
  -e INVENTORY_PREPROCESSING_WORKER_SECRET=image-smoke-worker
  -e HOSTNAME=0.0.0.0
)
docker run --rm --network none -e BETTER_AUTH_SECRET_FILE=/tmp/auth-secret "$image" sh -ec '
  bun run --cwd packages/auth auth-secret:init
  test -s "$BETTER_AUTH_SECRET_FILE"
'
docker run --rm "${environment[@]}" "$image" bun run --cwd packages/db migrate:deploy-only
docker exec -i "$db" psql -X -v ON_ERROR_STOP=1 -U fixture -d fixture <<'SQL'
INSERT INTO "user" (id, name, email, "updatedAt") VALUES ('fixture-owner', 'Fixture Owner', 'owner@example.test', now());
INSERT INTO auth_owner (id, "userId") VALUES ('singleton', 'fixture-owner');
SQL
docker run -d --name "$api" --network-alias api "${environment[@]}" "$image" bun run --cwd apps/api start:production >/dev/null
docker run -d --name "$web" "${environment[@]}" "$image" bun run --cwd apps/web start >/dev/null
probe() {
  local container=$1 path=$2 expected=${3:-200} supplied=${4:-}
  for attempt in {1..45}; do
    if docker exec "$container" bun -e 'const proof = process.argv[3]; const headers = proof ? {"x-quantself-owner-proof": proof} : {}; const res = await fetch(process.argv[1], {headers, signal: AbortSignal.timeout(2000)}); if (res.status !== Number(process.argv[2])) process.exit(1)' "$path" "$expected" "$supplied" 2>/dev/null; then
      echo "$container served $path"
      return
    fi
    sleep 1
  done
  return 1
}
probe "$api" http://127.0.0.1:3001/api/health
probe "$web" http://localhost:3000/ 403
probe "$web" http://localhost:3000/ 403 "$(printf "b%.0s" {1..64})"
probe "$web" http://localhost:3000/ 200 "$proof"
probe "$web" http://localhost:3000/login 404 "$proof"
probe "$api" http://127.0.0.1:3001/api/auth/get-session 404
probe "$web" http://localhost:3000/api/health
probe "$web" http://localhost:3000/notifications-sw.js 200 "$proof"
probe "$web" 'http://127.0.0.1:3000/_next/image?url=%2Finventory%2Fcontainer-visual-catalog%2F6l%2Fback.webp&w=1920&q=75'

docker run --rm "${environment[@]}" \
  -e INVENTORY_PREPROCESSING_WORKER_BASE_URL=http://api:3001 \
  -e GIRKE_API_TOKEN=image-smoke-girke -e GIRKE_API_BASE_URL=http://api:3001 \
  "$image" bun run --cwd apps/web run-inventory-preprocessing-worker --once

docker run --rm --network none "$image" sh -ec '
  test ! -e /app/apps/api/src/website-analytics-route.ts
  test ! -e /app/apps/api/src/website-analytics-standalone.ts
  for file in setup.ts stage-live.sh retention.sql; do
    test ! -e "/app/scripts/website-analytics/$file"
  done
  test "$(bun --version)" = 1.3.14
  tesseract --list-langs | grep -x eng
  pdftoppm -v
  cd apps/web
  bun run codex --version
  bun -e "await import(\"./lib/jobs-codex-worker.ts\")"
  bun build --target bun --external sharp --outdir /tmp/workers scripts/run-inventory-codex-enrichment-worker.ts
'
