#!/usr/bin/env bash
# Isolated synthetic application integration. Never reads project .env or production data.
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
trial_dir="$(mktemp -d "${TMPDIR:-/tmp}/qs-storage-integration.XXXXXX")"
chmod 700 "$trial_dir"
export INTEGRATION_PROJECT="qs-storage-integration-$(date +%s)-$$"
cp "$repo_root/scripts/integration/opencloud/compose.yaml" "$trial_dir/compose.yaml"
cp "$repo_root/scripts/integration/opencloud/bootstrap.mjs" "$trial_dir/bootstrap.mjs"
python3 - "$trial_dir" <<'PY'
from pathlib import Path
import secrets,sys
p=Path(sys.argv[1])/'.env'
p.write_text('IDM_ADMIN_PASSWORD='+secrets.token_urlsafe(24)+'\n')
p.chmod(0o600)
PY
compose=(docker compose -p "$INTEGRATION_PROJECT" -f "$trial_dir/compose.yaml")
cleanup() {
  "${compose[@]}" down --volumes >/dev/null 2>&1 || true
  printf 'Synthetic integration artifacts: %s\n' "$trial_dir"
}
trap cleanup EXIT
bun add --cwd "$trial_dir" playwright@1.61.1 >/dev/null
(cd "$trial_dir" && bunx playwright install chromium >/dev/null)
"${compose[@]}" run --rm opencloud init --insecure yes --quiet
"${compose[@]}" up -d --wait postgres
"${compose[@]}" up -d opencloud
for attempt in $(seq 1 60); do
  if curl --silent --fail --insecure https://localhost:19200/.well-known/openid-configuration >/dev/null; then break; fi
  sleep 1
done
published="$("${compose[@]}" port postgres 5432)"
export DATABASE_URL="postgresql://postgres@127.0.0.1:${published##*:}/quantself_storage_integration"
export INTEGRATION_REPO_ROOT="$repo_root"
export INTEGRATION_DIR="$trial_dir"
(cd "$repo_root/packages/db" && bun x --bun prisma migrate deploy)
node "$trial_dir/bootstrap.mjs"
