#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$#" -ne 3 || ! "$2" =~ ^[a-f0-9]{40}$ || ! "$3" =~ ^[1-9][0-9]{0,19}$ ]]; then
  echo "Invalid phone verification invocation." >&2
  exit 1
fi
cd "$1"
expected_revision="$2"
invocation_id="$3"
main_revision="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
if [[ "$main_revision" != "$expected_revision" || "$(git rev-parse HEAD)" != "$expected_revision" ]]; then
  echo "Phone verification rejected: current main revision required." >&2
  exit 1
fi
compose=(docker compose -f compose.yaml -f compose.prod.yaml)
container="$("${compose[@]}" ps -q api)"
if [[ -z "$container" || "$(docker inspect --format '{{.State.Running}}' "$container")" != true || "$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")" != "$expected_revision" ]]; then
  echo "Phone verification rejected: verified running image required." >&2
  exit 1
fi
"${compose[@]}" config --format json | python3 -c 'import json,sys; c=json.load(sys.stdin); sys.exit(0 if c["services"]["api"]["environment"].get("QUANTSELF_PHONE_ENABLED") == "1" else 1)'
docker exec "$container" sh -c 'test "${QUANTSELF_PHONE_ENABLED:-}" = 1' </dev/null
"${compose[@]}" exec -T api bun apps/api/scripts/verify-phone-call.ts "$invocation_id" </dev/null
