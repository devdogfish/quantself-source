#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd -- "$here/../../../.." && pwd)
agents="$repo/agents"
endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
[[ $endpoint == unix:///* ]] || { printf '%s\n' 'Use a local Docker Unix socket.' >&2; exit 1; }
docker_cmd() { docker --host "$endpoint" "$@"; }
run=$(python3 -c 'import uuid; print("qs359-api-client-" + uuid.uuid4().hex[:12])')
volume="${run}-socket"
image="$run:fixture"
scratch=$(mktemp -d)
cleanup() {
  failed=$?
  if (( failed )); then docker_cmd logs "$run" >&2 || true; fi
  docker_cmd container stop --timeout 1 "$run" >/dev/null 2>&1 || true
  docker_cmd container rm "$run" >/dev/null 2>&1 || true
  docker_cmd volume rm "$volume" >/dev/null 2>&1 || true
  docker_cmd image rm "$image" >/dev/null 2>&1 || true
  if [[ -f $scratch/probe.js ]]; then rm "$scratch/probe.js"; fi
  rmdir "$scratch"
}
trap cleanup EXIT
docker_cmd volume create "$volume" >/dev/null
host_socket_dir=$(docker_cmd volume inspect --format '{{.Mountpoint}}' "$volume")
bun build "$here/api-client-fixture/probe.ts" --target bun --outfile "$scratch/probe.js" >/dev/null
docker_cmd build --pull=false --quiet -t "$image" - <<'DOCKER' >/dev/null
FROM oven/bun:1.3.14-alpine
RUN apk add --no-cache su-exec=0.2-r3
DOCKER

source_mount="type=bind,src=$agents/sam/jobs-mail,dst=/fixture/agents/sam/jobs-mail,readonly"
socket_mount="type=volume,src=$volume,dst=/run/quantself-roundcube-observer"
client_mount="type=bind,src=$host_socket_dir,dst=/run/quantself-roundcube-observer,readonly"
fixture="/fixture/agents/sam/jobs-mail/roundcube-observer-deploy/api-client-fixture"
docker_cmd run -d --name "$run" --pull=never --network none \
  --mount "$source_mount" --mount "$socket_mount" \
  --mount "type=bind,src=$agents/vaultwarden/mail.py,dst=/fixture/agents/vaultwarden/mail.py,readonly" \
  python:3.13-slim python3 -IB "$fixture/peer.py" >/dev/null
for ((attempt=0; attempt<30; attempt++)); do
  if docker_cmd logs "$run" 2>/dev/null | grep -qx ready; then break; fi
  sleep 0.1
done
docker_cmd logs "$run" 2>/dev/null | grep -qx ready

api_source="type=bind,src=$repo/apps/api/src,dst=/app/apps/api/src,readonly"
probe="type=bind,src=$scratch/probe.js,dst=/proof/probe.js,readonly"
docker_cmd run --rm --pull=never --network none --tmpfs /api-private:rw,nosuid,nodev,mode=0700 \
  --mount "$api_source" --mount "$probe" --mount "$client_mount" \
  "$image" /usr/local/bin/bun --no-env-file /proof/probe.js
[[ $(docker_cmd wait "$run") == 0 ]]
docker_cmd logs "$run"
docker_cmd run --rm --pull=never --network none --mount "$api_source" --mount "$probe" \
  "$image" /usr/local/bin/bun --no-env-file /proof/probe.js child-failure
