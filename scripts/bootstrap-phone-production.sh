#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$#" -ne 2 || ! "$2" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Usage: bootstrap-phone-production.sh DEPLOY_PATH MAIN_SHA" >&2
  exit 1
fi
cd "$1"
expected_revision="$2"
# Bootstrap is configuration only: never fetch/reset source, build, restart, or deploy.
main_revision="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
if [[ "$main_revision" != "$expected_revision" || "$(git rev-parse HEAD)" != "$expected_revision" ]]; then
  echo "Phone bootstrap rejected: server/workflow must match current origin/main." >&2
  exit 1
fi
git diff --quiet HEAD -- scripts/provision-runtime-env.py || { echo "Phone bootstrap rejected: server provisioning script has local edits." >&2; exit 1; }
compose=(docker compose -f compose.yaml -f compose.prod.yaml)
container="$("${compose[@]}" ps -q api)"
if [[ -z "$container" || "$(docker inspect --format '{{.State.Running}}' "$container")" != true || "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")" != "$expected_revision" ]]; then
  echo "Phone bootstrap rejected: running API must match verified main revision." >&2
  exit 1
fi
# Check both the next Compose configuration and the current process remain disabled.
"${compose[@]}" config --format json | python3 -c 'import json,sys; c=json.load(sys.stdin); sys.exit(1 if c["services"]["api"]["environment"].get("QUANTSELF_PHONE_ENABLED") == "1" else 0)'
docker exec "$container" sh -c 'test "${QUANTSELF_PHONE_ENABLED:-}" != 1' </dev/null
capture_root="$(docker exec "$container" sh -c 'printf %s "${QUANTSELF_TODO_CAPTURE_ROOT:-/app/storage/todo-captures}"' </dev/null)"
if [[ "$capture_root" != /* || "$capture_root" == *$'\n'* || "$capture_root" == *$'\r'* ]]; then
  echo "Phone bootstrap rejected: invalid capture root." >&2
  exit 1
fi
# SSH streams this script on stdin; child commands must not consume its footer.
"${compose[@]}" exec -T api bun apps/api/scripts/bootstrap-phone-jarvis.ts --apply </dev/null
# Secrets remain server-side; docker cp preserves the fragment private file mode.
private_directory="$PWD/.private-phone"
if [[ -L "$private_directory" ]]; then
  echo "Phone bootstrap rejected: private directory cannot be a symlink." >&2
  exit 1
fi
install -m 700 -d "$private_directory"
runtime_file="$private_directory/runtime.env"
if [[ -e "$runtime_file" || -L "$runtime_file" ]]; then
  # Only this rebuildable bootstrap export is replaced, never source recordings.
  rm -- "$runtime_file"
fi
docker cp "$container:$capture_root/.phone-bootstrap/runtime.env" "$runtime_file"
chmod 600 "$runtime_file"
python3 scripts/provision-runtime-env.py "$PWD/.env" --phone-runtime-file "$runtime_file"
echo "Phone runtime bootstrapped and merged; services unchanged, phone disabled."
