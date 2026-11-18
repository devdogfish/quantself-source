#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: bun run data:pull-production --yes

Replaces local non-auth data and inventory media with production snapshots.
Production is read-only. Local auth, API security state, migration history,
auth secrets, and Codex login state are preserved.

Overrides:
  QUANTSELF_SSH_TARGET              default: root@hostinger-vps
  QUANTSELF_REMOTE_POSTGRES         default: quantself-postgres
  QUANTSELF_REMOTE_APP              default: quantself-next
  QUANTSELF_DEV_PROJECT_NAME        default: quantself-dev
  QUANTSELF_COMPOSE_BASE_FILE       default: compose.yaml
  QUANTSELF_COMPOSE_DEV_FILE        default: compose.dev.yaml
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "$#" -ne 1 || "$1" != "--yes" ]]; then
  usage >&2
  echo "Refusing to replace local data without --yes." >&2
  exit 1
fi

if [[ -n "${QUANTSELF_SHARED_DEV_DATABASE:-}" ]]; then
  echo "Production data pull targets a legacy checkout. Clear QUANTSELF_SHARED_DEV_DATABASE and select the legacy project before pulling." >&2
  exit 1
fi

ssh_target="${QUANTSELF_SSH_TARGET:-root@hostinger-vps}"
remote_postgres="${QUANTSELF_REMOTE_POSTGRES:-quantself-postgres}"
remote_app="${QUANTSELF_REMOTE_APP:-quantself-next}"
dev_project="${QUANTSELF_DEV_PROJECT_NAME:-quantself-dev}"
if [[ "$dev_project" == "quantself-shared-dev" ]]; then
  echo "Production data pull requires a legacy checkout database." >&2
  exit 1
fi
compose_base="${QUANTSELF_COMPOSE_BASE_FILE:-compose.yaml}"
compose_dev="${QUANTSELF_COMPOSE_DEV_FILE:-compose.dev.yaml}"
compose=(
  docker compose
  --project-name "$dev_project"
  -f "$compose_base"
  -f "$compose_dev"
)

for value in "$remote_postgres" "$remote_app"; do
  if [[ ! "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
    echo "Invalid remote container name: $value" >&2
    exit 1
  fi
done

auth_tables=(
  user
  session
  account
  verification
  passkey
  apikey
  auth_owner
  owner_setup_token
  api_idempotency_key
  api_idempotency_request
  _prisma_migrations
)
media_paths=(
  /app/storage/inventory-images
  /app/storage/inventory-audio
  /app/storage/inventory-assets
)
media_names=(images audio assets)

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/quantself-production-data.XXXXXX")"
database_archive="$temporary_directory/production.dump"
restore_log="$temporary_directory/restore.log"
previously_running=()
local_services_stopped=false

cleanup() {
  local exit_code="$?"
  trap - EXIT
  set +e

  if [[ "$local_services_stopped" == "true" && "${#previously_running[@]}" -gt 0 ]]; then
    "${compose[@]}" start "${previously_running[@]}" >/dev/null
  fi
  rm -rf "$temporary_directory"
  exit "$exit_code"
}
trap cleanup EXIT

echo "Checking local Docker and production SSH access."
docker version >/dev/null
docker compose version >/dev/null
"${compose[@]}" config --quiet
"${compose[@]}" ps --all
docker ps >/dev/null
ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_target" true
ssh "$ssh_target" "docker ps --filter name=^/${remote_postgres}$ --format '{{.Names}}'" |
  grep -Fx "$remote_postgres" >/dev/null
ssh "$ssh_target" "docker ps --filter name=^/${remote_app}$ --format '{{.Names}}'" |
  grep -Fx "$remote_app" >/dev/null

local_postgres="$("${compose[@]}" ps --quiet postgres)"
if [[ -z "$local_postgres" ]]; then
  local_postgres="$("${compose[@]}" ps --all --quiet postgres)"
  if [[ -n "$local_postgres" ]]; then
    echo "Starting existing local PostgreSQL container."
    docker start "$local_postgres" >/dev/null
  fi
fi
if [[ -z "$local_postgres" ]]; then
  echo "Local Docker PostgreSQL container was not found; start the development stack first." >&2
  exit 1
fi
for attempt in {1..30}; do
  if docker exec "$local_postgres" sh -c \
    'pg_isready --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' >/dev/null; then
    break
  fi
  if [[ "$attempt" -eq 30 ]]; then
    echo "Local Docker PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 1
done

exclude_arguments=""
for table in "${auth_tables[@]}"; do
  printf -v exclude_arguments '%s --exclude-table-data=public.%q' \
    "$exclude_arguments" "$table"
done

echo "Snapshotting production database."
ssh "$ssh_target" \
  "docker exec $remote_postgres sh -c 'exec pg_dump --format=custom --data-only --no-owner --no-privileges$exclude_arguments --username=\"\$POSTGRES_USER\" --dbname=\"\$POSTGRES_DB\"'" \
  >"$database_archive"
docker exec -i "$local_postgres" pg_restore --list \
  <"$database_archive" >/dev/null

for index in "${!media_paths[@]}"; do
  echo "Snapshotting production inventory ${media_names[$index]}."
  ssh "$ssh_target" \
    "docker exec $remote_app tar -C ${media_paths[$index]} -cf - ." \
    >"$temporary_directory/${media_names[$index]}.tar"
  tar -tf "$temporary_directory/${media_names[$index]}.tar" >/dev/null
done

while IFS= read -r service; do
  [[ -n "$service" ]] && previously_running+=("$service")
done < <(
  "${compose[@]}" ps --services --filter status=running |
    grep -E '^(app|api|gateway)$' || true
)
if [[ "${#previously_running[@]}" -gt 0 ]]; then
  echo "Stopping local data consumers."
  "${compose[@]}" stop "${previously_running[@]}"
  local_services_stopped=true
fi

echo "Applying local migrations."
"${compose[@]}" run --rm --no-deps --interactive=false migrate

echo "Clearing local non-auth tables."
docker exec -i "$local_postgres" sh -c \
  'exec psql --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  <<'SQL'
DO $quantself$
DECLARE
  table_list text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename)
    INTO table_list
    FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename NOT IN (
       'user', 'session', 'account', 'verification', 'passkey', 'apikey',
       'auth_owner', 'owner_setup_token', 'api_idempotency_key',
       'api_idempotency_request', '_prisma_migrations'
     );

  IF table_list IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY';
  END IF;
END
$quantself$;
SQL

echo "Restoring compatible production table data."
set +e
docker exec -i "$local_postgres" sh -c \
  'exec pg_restore --data-only --disable-triggers --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  <"$database_archive" 2>"$restore_log"
restore_exit_code="$?"
set -e
if [[ "$restore_exit_code" -ne 0 ]]; then
  if grep -Eqi \
    'no space left|could not connect|connection .*closed|server closed|out of memory|panic|fatal' \
    "$restore_log"; then
    echo "Production restore failed for an infrastructure reason:" >&2
    sed -n '/error:/Ip; /fatal:/Ip' "$restore_log" >&2
    exit "$restore_exit_code"
  fi
  echo "Some production tables were incompatible and stayed empty:" >&2
  sed -n '/error:/Ip' "$restore_log" >&2
fi

for index in "${!media_paths[@]}"; do
  echo "Replacing local inventory ${media_names[$index]}."
  "${compose[@]}" run --rm --no-deps --entrypoint sh app -c \
    'target="$1"; find "$target" -mindepth 1 -exec rm -rf -- {} +; tar -C "$target" -xf -' \
    sh "${media_paths[$index]}" <"$temporary_directory/${media_names[$index]}.tar"
done

if [[ "${#previously_running[@]}" -gt 0 ]]; then
  echo "Restarting local services."
  "${compose[@]}" start "${previously_running[@]}"
  local_services_stopped=false
fi

echo "Local non-auth data and inventory media now match compatible production data."
