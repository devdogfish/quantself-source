#!/usr/bin/env bash
# Run one transient Jobs Codex batch without overlapping a Keep backup or deploy.
set -euo pipefail

if [[ "$#" -ne 1 || "$1" != /* || "$EUID" != 0 ]]; then
  echo "Usage as root: run-home-jobs-codex-worker.sh DEPLOY_PATH" >&2
  exit 1
fi
cd -- "$1"

exec 9>>/run/lock/quantself-production.lock
flock -n 9 || { echo "Keep deployment or backup is active." >&2; exit 1; }
maintenance=/var/lib/keep-backup/production-maintenance.json
if [[ -e "$maintenance" || -L "$maintenance" ]]; then
  echo "Keep backup or recovery requires reconciliation." >&2
  exit 1
fi

release_state=/var/lib/quantself-release
if [[ -e "$release_state/pending" ]]; then
  echo "A Keep release switch requires recovery." >&2
  exit 1
fi
slot=legacy
run_pull=()
if [[ -e "$release_state/active" ]]; then
  read -r slot < "$release_state/active"
fi
case "$slot" in
  legacy)
    project=quantself
    run_pull=(--pull never)
    compose=(docker compose --project-name "$project" -f compose.yaml -f compose.prod.yaml -f compose.home.yaml)
    revision="$(git rev-parse HEAD)"
    image="$(docker image inspect --format '{{.Id}}' quantself-app)"
    ;;
  blue|green)
    project="quantself-$slot"
    compose=(docker compose --project-name "$project" --env-file /dev/null -f "$release_state/$slot/runtime.json")
    readarray -t release < "$release_state/$slot/release"
    [[ "${#release[@]}" == 2 && "${release[0]}" =~ ^[0-9a-f]{40}$ && "${release[1]}" =~ ^sha256:[0-9a-f]{64}$ ]]
    revision="${release[0]}"
    image="${release[1]}"
    ;;
  *) echo "Invalid Keep release state." >&2; exit 1 ;;
esac
api="$("${compose[@]}" ps --quiet api)"
if [[ ! "$api" =~ ^[a-f0-9]{12,64}$ ]]; then
  echo "The active Keep API container could not be identified." >&2
  exit 1
fi

running="$(docker inspect --type container --format '{{.State.Running}} {{.Image}}' "$api")"
image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
if [[ "$running" != "true $image" || "$image_revision" != "$revision" ]]; then
  echo "The Jobs Codex batch requires the active Keep release and its matching image." >&2
  exit 1
fi

existing="$(docker ps --all --format '{{.Label "com.docker.compose.project"}}' \
  --filter label=com.docker.compose.service=jobs-codex-worker)"
if grep -Eq '^quantself(-blue|-green)?$' <<< "$existing"; then
  echo "An earlier Jobs Codex batch requires reconciliation." >&2
  exit 1
fi

outbox_path=/var/lib/docker/volumes/quantself_quantself_jobs_codex_outbox/_data
outbox="$(docker volume inspect --format '{{.Driver}} {{.Scope}} {{len .Options}} {{index .Labels "com.docker.compose.project"}} {{index .Labels "com.docker.compose.volume"}} {{.Mountpoint}}' \
  quantself_quantself_jobs_codex_outbox 2>/dev/null)" || outbox=""
if [[ "$outbox" != "local local 0 quantself quantself_jobs_codex_outbox $outbox_path" ]]; then
  echo "Stage the reviewed Jobs Codex outbox volume before running a batch." >&2
  exit 1
fi

"${compose[@]}" --profile jobs-worker run --rm --no-deps "${run_pull[@]}" \
  --interactive=false --no-TTY jobs-codex-worker </dev/null
