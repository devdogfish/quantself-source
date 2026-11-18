#!/usr/bin/env bash

set -euo pipefail

worker_services=(
  inventory-preprocessing-worker
  inventory-codex-enrichment-worker
)
if [[ "${QUANTSELF_DEPLOY_TARGET:-}" == home ]]; then
  worker_services=(inventory-codex-enrichment-worker)
  state="$(docker inspect --format '{{.State.Status}}' quantself-inventory-preprocessing-worker)"
  if [[ "$state" != created && "$state" != exited ]]; then
    echo "Inventory preprocessing worker must stay stopped on Keep." >&2
    exit 1
  fi
fi

for service in "${worker_services[@]}"; do
  container_id="$(docker compose ps --quiet "$service")"

  if [[ -z "$container_id" ]]; then
    echo "Inventory worker smoke check failed: $service has no container." >&2
    exit 1
  fi

  status="$(docker inspect --format '{{.State.Status}}' "$container_id")"

  if [[ "$status" != "running" ]]; then
    echo "Inventory worker smoke check failed: $service is $status." >&2
    docker compose logs --tail 40 "$service" >&2
    exit 1
  fi
done

if ! docker compose run --rm --no-deps --interactive=false \
  --entrypoint /app/apps/web/node_modules/.bin/codex \
  inventory-codex-enrichment-worker login status >/dev/null 2>&1; then
  echo "Inventory worker smoke check failed: Codex auth is missing or invalid. Run: docker compose run --rm --entrypoint /app/apps/web/node_modules/.bin/codex inventory-codex-enrichment-worker login" >&2
  exit 1
fi

if [[ "${QUANTSELF_DEPLOY_TARGET:-}" != home ]] && ! docker compose run --rm --no-deps --interactive=false --entrypoint bun \
  inventory-preprocessing-worker \
  -e 'const base=process.env.GIRKE_API_BASE_URL.trim().replace(/\/+$/,""); const response=await fetch(`${base}/api/v1/ocr`,{headers:{Authorization:`Bearer ${process.env.GIRKE_API_TOKEN}`}}); if(!response.ok) { console.error(`Girke probe returned HTTP ${response.status}.`); process.exit(1) }' \
  >/dev/null; then
  echo "Inventory worker smoke check failed: Girke credentials are invalid or unreachable." >&2
  exit 1
fi

declare -A restart_counts

for service in "${worker_services[@]}"; do
  container_id="$(docker compose ps --quiet "$service")"
  restart_counts["$service"]="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
done

sleep 5

for service in "${worker_services[@]}"; do
  container_id="$(docker compose ps --quiet "$service")"
  status="$(docker inspect --format '{{.State.Status}}' "$container_id")"
  restart_count="$(docker inspect --format '{{.RestartCount}}' "$container_id")"

  if [[ "$status" != "running" || "$restart_count" != "${restart_counts[$service]}" ]]; then
    echo "Inventory worker smoke check failed: $service is unstable." >&2
    docker compose logs --tail 40 "$service" >&2
    exit 1
  fi
done

echo "Active Inventory workers are stable and their credentials are valid."
