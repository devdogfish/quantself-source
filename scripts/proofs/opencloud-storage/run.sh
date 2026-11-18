#!/usr/bin/env bash
# Isolated, synthetic storage trial. No production or existing project DB access.
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
trial_dir="$(mktemp -d "${TMPDIR:-/tmp}/qs-storage-proof.XXXXXX")"
chmod 700 "$trial_dir"
export PROOF_PROJECT="qs-storage-proof-$(date +%s)-$$"
cp "$source_dir/compose.yaml" "$source_dir/proof.mjs" "$trial_dir/"
python3 - "$trial_dir" <<'PY'
from pathlib import Path
import secrets,sys
p=Path(sys.argv[1])/'.env'
p.write_text('IDM_ADMIN_PASSWORD='+secrets.token_urlsafe(24)+'\n')
p.chmod(0o600)
PY
compose=(docker compose -p "$PROOF_PROJECT" -f "$trial_dir/compose.yaml")
cleanup() {
  if [[ -f "$trial_dir/restore.yaml" ]]; then
    "${compose[@]}" -f "$trial_dir/restore.yaml" down --volumes >/dev/null 2>&1 || true
  fi
  "${compose[@]}" down --volumes >/dev/null 2>&1 || true
  printf 'Proof artifacts (local synthetic credentials included; keep private): %s\n' "$trial_dir"
}
trap cleanup EXIT
bun add --cwd "$trial_dir" playwright@1.61.1
(cd "$trial_dir" && bunx playwright install chromium)
"${compose[@]}" run --rm opencloud init --insecure yes --quiet
"${compose[@]}" up -d
for attempt in $(seq 1 60); do
  if curl --silent --fail --insecure https://localhost:19200/.well-known/openid-configuration >/dev/null; then break; fi
  sleep 1
done
node "$trial_dir/proof.mjs"
