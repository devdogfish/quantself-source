#!/usr/bin/env bash
# Read-only: no sourcing .env, image changes, migrations, logs, or task reads.
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Usage: preflight-production.sh DEPLOY_PATH" >&2
  exit 1
fi
cd "$1"
compose=(docker compose -f compose.yaml -f compose.prod.yaml)
if [[ "${QUANTSELF_DEPLOY_TARGET:-}" == home ]]; then
  compose+=(-f compose.home.yaml)
  "${compose[@]}" config --quiet
fi
failed=0
if [[ ! -r .env ]]; then
  echo "MISSING: production .env"
  exit 1
fi
read_value() {
  local value
  value="$(sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" .env | tail -n 1)"
  value="${value#\"}"; value="${value%\"}"; value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}
required=(
  DATABASE_URL QUANTSELF_INSTANCE_NAME QUANTSELF_OWNER_EMAIL
  QUANTSELF_TODO_REPOSITORY QUANTSELF_TODO_TEST_REPOSITORY
  QUANTSELF_GITHUB_APP_ID QUANTSELF_GITHUB_INSTALLATION_ID QUANTSELF_GITHUB_PRIVATE_KEY
  QUANTSELF_GITHUB_WEBHOOK_SECRET QUANTSELF_ELEVENLABS_API_KEY QUANTSELF_ELEVENLABS_AGENT_ID
)
if [[ "${QUANTSELF_DEPLOY_TARGET:-}" == home ]]; then
  required+=(
    QUANTSELF_WEBSITE_ANALYTICS_INGEST_TOKEN QUANTSELF_TRACKED_LINKS_READ_TOKEN
    QUANTSELF_TRACKED_LINKS_APPLICATION_TOKEN QUANTSELF_TRACKED_LINKS_SHARE_TOKEN
  )
fi
for key in "${required[@]}"; do
  value="$(read_value "$key")"
  if [[ -z "${value//[[:space:]]/}" || "$value" == \#* ]]; then
    echo "MISSING: $key"; failed=1
  else
    echo "PRESENT: $key"
  fi
done
for key in QUANTSELF_TODO_PROJECT_NUMBER QUANTSELF_JARVIS_TOOL_ORIGIN; do
  value="$(read_value "$key")"
  if [[ -z "${value//[[:space:]]/}" ]]; then echo "OPTIONAL ABSENT: $key"; else echo "PRESENT: $key"; fi
done
app_origin="$(read_value QUANTSELF_PUBLIC_ORIGIN)"
if [[ -z "$app_origin" ]]; then app_origin="$(read_value BETTER_AUTH_URL)"; fi
if [[ ! "$app_origin" =~ ^https://[^/]+/?$ ]]; then
  echo "INVALID: QUANTSELF_PUBLIC_ORIGIN requires one HTTPS origin"; failed=1
else
  echo "PRESENT: QUANTSELF_PUBLIC_ORIGIN"
fi
origin="$(read_value QUANTSELF_JARVIS_TOOL_ORIGIN)"
if [[ -z "$origin" ]]; then origin="$app_origin"; fi
if [[ "$origin" != https://* || "$origin" == *trycloudflare.com* ]]; then
  echo "INVALID: Jarvis production callback requires a stable HTTPS origin"; failed=1
else
  echo "PASS: Jarvis production origin configured"
fi
if [[ "$(read_value QUANTSELF_TODO_REPOSITORY)" == "$(read_value QUANTSELF_TODO_TEST_REPOSITORY)" ]]; then
  echo "INVALID: task and test repositories must differ"; failed=1
fi
for service in postgres app api gateway inventory-preprocessing-worker inventory-codex-enrichment-worker; do
  if [[ "${QUANTSELF_DEPLOY_TARGET:-}" == home && "$service" == inventory-preprocessing-worker ]]; then
    state="$(docker inspect --format '{{.State.Status}}' quantself-inventory-preprocessing-worker 2>/dev/null)" || state=""
    if [[ "$state" == created || "$state" == exited ]]; then
      echo "PAUSED: $service"
    else
      echo "UNHEALTHY: $service is not paused"; failed=1
    fi
    continue
  fi
  container="$("${compose[@]}" ps --quiet "$service" 2>/dev/null)" || container=""
  status=""
  if [[ -n "$container" && "$container" != *$'\n'* ]]; then
    status="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null)" || status=""
  fi
  if [[ "$status" == "running healthy" || "$status" == "running none" ]]; then
    echo "HEALTHY: $service"
  else
    echo "UNHEALTHY: $service"; failed=1
  fi
done
if [[ "${QUANTSELF_DEPLOY_TARGET:-}" == home ]]; then
  if "${compose[@]}" exec -T api bun scripts/check-jobs-resume-templates.ts </dev/null >/dev/null 2>&1; then
    echo "PASS: three private Jobs résumé templates"
  else
    echo "FAILED: private Jobs résumé templates"; failed=1
  fi
fi
# Query migration bookkeeping only, inside an enforced read-only transaction.
# Suppress framework diagnostics; they can include connection configuration.
migration_status=0
migration_output="$("${compose[@]}" exec -T api bun - 2>/dev/null <<'BUN'
import { prisma } from "/app/packages/db/index.ts";
try {
  const [status] = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return tx.$queryRawUnsafe('SELECT count(*) FILTER (WHERE finished_at IS NOT NULL)::int AS applied, count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS unfinished FROM "_prisma_migrations"');
  });
  console.log(`MIGRATIONS: ${status.applied} applied; ${status.unfinished} unfinished`);
  if (status.unfinished) process.exitCode = 1;
} catch {
  console.log("UNAVAILABLE: migration bookkeeping query"); process.exitCode = 1;
} finally { await prisma.$disconnect(); }
BUN
)" || migration_status=$?
# Only allow the intended numerical summary out of the container process.
summary="$(printf '%s\n' "$migration_output" | sed -n '/^MIGRATIONS: [0-9][0-9]* applied; [0-9][0-9]* unfinished$/p')"
if [[ -n "$summary" ]]; then printf '%s\n' "$summary"; fi
if [[ "$migration_status" -ne 0 || -z "$summary" ]]; then
  echo "FAILED: read-only migration status"; failed=1
fi
if [[ "$failed" -ne 0 ]]; then
  echo "Production preflight failed; no production changes made."
  exit 1
fi
echo "Production preflight passed; credentials present, services healthy, no unfinished migrations. No production changes made."
echo "Credential validity, provider callback targets, and pending release migrations require separate verification."
