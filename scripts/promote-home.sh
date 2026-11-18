#!/usr/bin/env bash
# The root broker verifies the release, loads its image and holds the production lock.
set -Eeuo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
action="${1:-}"
deploy_path="${2:-}"
[[ "$EUID" == 0 && "$deploy_path" == /* ]] || fail "Use the root Keep release broker."
case "$action:$#" in
  promote:4|rollback:2|recover:2|rollback-verified:11) ;;
  *) fail "Usage: promote-home.sh promote DEPLOY_PATH REVISION IMAGE_ID | (rollback|recover) DEPLOY_PATH | rollback-verified DEPLOY_PATH SLOT REVISION IMAGE_ID GATEWAY_IMAGE_ID API_ID APP_ID GATEWAY_ID API_WORKERS_ID ENRICHMENT_ID" ;;
esac
verified_slot=
verified_services=(api app gateway api-workers inventory-codex-enrichment-worker)

source_tree="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
state=/var/lib/quantself-release
ingress=/etc/quantself-ingress/Keep.Caddyfile
template="$ingress.release-template"
[[ -f "$template" && -S /run/quantself-ingress/admin.sock ]] ||
  fail "Bootstrap the reloadable Keep ingress before staging a release."
grep -Fxq $'\tadmin unix//run/quantself-ingress/admin.sock' "$template" ||
  fail "Keep ingress release template has no private admin socket."
[[ "$(grep -Ec '127\.0\.0\.1:3000([^0-9]|$)' "$template")" == 3 &&
   "$(grep -Ec '127\.0\.0\.1:3001([^0-9]|$)' "$template")" == 1 ]] ||
  fail "Keep ingress release template upstreams differ from the reviewed routes."

if [[ "$action" != rollback-verified ]]; then install -d -m 0700 "$state"; fi
export COMPOSE_PROFILES=
origin=https://qs.girke.dev
https_ip="${QUANTSELF_PRODUCTION_HTTPS_IP:-${PRODUCTION_HTTPS_IP:-}}"
[[ "$https_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail "Keep ingress address is required for the post-switch HTTPS probe."

web_port() {
  case "$1" in legacy) echo 3000 ;; blue) echo 13000 ;; green) echo 13002 ;; esac
}
slot_exists() { [[ "$1" == legacy || "$1" == blue || "$1" == green ]]; }

slot_compose() {
  local slot="$1"
  shift
  docker compose --project-name "quantself-$slot" --env-file /dev/null \
    -f "$state/$slot/runtime.json" "$@"
}

container() {
  local slot="$1" service="$2"
  if [[ "$slot" == "$verified_slot" ]]; then
    local index
    for index in "${!verified_services[@]}"; do
      if [[ "$service" == "${verified_services[$index]}" ]]; then
        printf '%s\n' "${verified_ids[$index]}"
        return
      fi
    done
  fi
  if [[ "$slot" != legacy ]]; then
    printf 'quantself-%s-%s-1\n' "$slot" "$service"
    return
  fi
  case "$service" in
    app) echo quantself-next ;;
    api) echo quantself-api ;;
    gateway) echo quantself-web ;;
    inventory-codex-enrichment-worker) echo quantself-inventory-codex-worker ;;
    inventory-preprocessing-worker) echo quantself-inventory-preprocessing-worker ;;
    *) return 1 ;;
  esac
}

verify_rollback_target() {
  # The caller holds the deploy lock from preflight through handoff.
  # Recheck names at this boundary before enabling the verified start IDs.
  local slot="$1" revision="$2" image="$3" gateway_image="$4"
  shift 4
  [[ "$active" != legacy && ( "$slot" == blue || "$slot" == green ) && "$slot" == "$prior" ]] ||
    fail "Verified rollback requires the approved managed prior slot."
  [[ "$revision" =~ ^[0-9a-f]{40}$ && "$image" =~ ^sha256:[0-9a-f]{64}$ && "$gateway_image" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    fail "Invalid verified rollback release identifiers."
  [[ ! -L "$state/pending" && ! -L "$state/$slot/release" ]] &&
    cmp -s "$state/$slot/release" <(printf '%s\n%s\n' "$revision" "$image") ||
    fail "Verified rollback release record differs from approval."
  verified_ids=("$@")
  local index name id expected_image observed seen=" "
  local -a names=() expected=()
  for index in "${!verified_services[@]}"; do
    name="$(container "$slot" "${verified_services[$index]}")"
    id="${verified_ids[$index]}"
    [[ "$id" =~ ^[0-9a-f]{64}$ ]] || fail "Invalid verified rollback container ID."
    [[ "$seen" != *" $id "* ]] || fail "Duplicate verified rollback container IDs."
    seen+="$id "
    expected_image="$image"
    if [[ "${verified_services[$index]}" == gateway ]]; then expected_image="$gateway_image"; fi
    names+=("$name")
    expected+=("/$name $id $expected_image")
  done
  observed="$(docker container inspect --format '{{.Name}} {{.Id}} {{.Image}}' "${names[@]}")" ||
    fail "Verified rollback containers could not be inspected."
  [[ "$(printf '%s\n' "$observed" | LC_ALL=C sort)" == "$(printf '%s\n' "${expected[@]}" | LC_ALL=C sort)" ]] ||
    fail "Verified rollback container names or identities changed."
  verified_slot="$slot"
}

read_slots() {
  readarray -t slots < "$1"
  [[ "${#slots[@]}" == 2 ]] && slot_exists "${slots[0]}" &&
    { [[ -z "${slots[1]}" ]] || slot_exists "${slots[1]}"; } &&
    [[ "${slots[0]}" != "${slots[1]}" ]]
}

write_slots() {
  local file="$1" next="$2" previous="$3" temporary
  temporary="$(mktemp "$state/.slots.XXXXXXXX")"
  printf '%s\n%s\n' "$next" "$previous" > "$temporary"
  sync -f "$temporary"
  mv -fT "$temporary" "$file"
  sync -f "$state"
}

render_routes() {
  local port
  port="$(web_port "$1")"
  sed -E -e "s/127\.0\.0\.1:3000([^0-9]|$)/127.0.0.1:$port\1/g" \
    -e "s/127\.0\.0\.1:3001([^0-9]|$)/127.0.0.1:$((port + 1))\1/g" "$template"
}

set_routes() {
  local temporary
  temporary="$(mktemp "${ingress}.XXXXXXXX")"
  chmod --reference="$ingress" "$temporary"
  chown --reference="$ingress" "$temporary"
  render_routes "$1" > "$temporary"
  sync -f "$temporary"
  mv -fT "$temporary" "$ingress"
  sync -f "$(dirname -- "$ingress")"
  systemctl reload quantself-ingress.service
}

start_containers() {
  local slot="$1" service name
  shift
  for service in "$@"; do
    name="$(container "$slot" "$service")"
    if [[ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]]; then
      docker start "$name" >/dev/null
    fi
  done
}

stop_containers() {
  local slot="$1" service name code
  shift
  for service in "$@"; do
    name="$(container "$slot" "$service")"
    if [[ "$(docker inspect --format '{{.State.Running}}' "$name")" == true ]]; then
      docker stop "$name" >/dev/null
      code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
      [[ "$code" == 0 || ( "$service" == app && "$code" == 143 ) ]] ||
        fail "Container did not drain cleanly: $name"
    fi
  done
}

ready() {
  local slot="$1" port status end=$((SECONDS + 90))
  port="$(web_port "$slot")"
  while (( SECONDS < end )); do
    if curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$port/favicon.ico" -o /dev/null 2>/dev/null &&
      curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$port/api/health" |
        jq -e '.service == "quantself-api" and .status == "ok"' >/dev/null; then
      status="$(curl -sS --noproxy '*' --max-time 2 -o /dev/null -w '%{http_code}' -X POST \
        "http://127.0.0.1:$((port + 1))/api/internal/jobs/runner/heartbeat")"
      [[ "$status" == 401 ]] && return
    fi
    sleep 1
  done
  fail "Web, API or direct Jobs lane did not become ready for $slot."
}

smoke() {
  local options=(--silent --show-error --noproxy '*' --max-time 5 --resolve "qs.girke.dev:443:$https_ip")
  curl "${options[@]}" --fail "$origin/favicon.ico" -o /dev/null &&
    curl "${options[@]}" --fail "$origin/api/health" |
    jq -e '.service == "quantself-api" and .status == "ok"' >/dev/null &&
    [[ "$(curl "${options[@]}" -o /dev/null -w '%{http_code}' -X POST \
      "$origin/api/internal/jobs/runner/heartbeat")" == 404 ]]
}

stop_background() {
  local slot="$1"
  stop_containers "$slot" inventory-codex-enrichment-worker
  if [[ "$slot" != legacy ]]; then stop_containers "$slot" api-workers; fi
}

start_background() {
  local slot="$1"
  if [[ "$slot" != legacy ]]; then start_containers "$slot" api-workers; fi
  start_containers "$slot" inventory-codex-enrichment-worker
  local service name count index
  local services=(inventory-codex-enrichment-worker)
  local counts=()
  if [[ "$slot" != legacy ]]; then services+=(api-workers); fi
  for service in "${services[@]}"; do
    name="$(container "$slot" "$service")"
    counts+=("$(docker inspect --format '{{.RestartCount}}' "$name")")
  done
  sleep 5
  for index in "${!services[@]}"; do
    name="$(container "$slot" "${services[$index]}")"
    count="$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' "$name")"
    [[ "$count" == "true ${counts[$index]}" ]] || fail "Candidate worker is unstable: $name"
  done
}

stop_http() {
  # Gateway SIGTERM drains requests before the application processes stop.
  stop_containers "$1" gateway app api
}

recover() {
  local old="$1" attempted="$2"
  # Legacy starts its workers when the API starts.
  if [[ "$old" == legacy ]]; then stop_background "$attempted"; fi
  start_containers "$old" api app gateway
  ready "$old"
  set_routes "$old"
  smoke
  stop_background "$attempted"
  stop_http "$attempted"
  start_background "$old"
}

stage() {
  local slot="$1" revision="$2" image="$3" dir network inspector file service
  dir="$state/$slot"
  network="quantself-$slot-backend"
  if [[ -e "$dir/runtime.json" ]]; then
    slot_compose "$slot" --profile '*' down --remove-orphans
  fi

  install -d -m 0700 "$dir"
  for file in compose.yaml compose.prod.yaml compose.home.yaml Caddyfile Caddyfile.home; do
    install -m 0644 "$source_tree/$file" "$dir/$file"
  done
  printf '%s\n%s\n' "$revision" "$image" > "$dir/release"
  QUANTSELF_DEPLOY_TARGET=home bash "$source_tree/scripts/check-inventory-worker-config.sh" "$deploy_path/.env"
  bash "$source_tree/scripts/check-api-foundation-config.sh" "$deploy_path/.env"

  if ! docker network inspect "$network" >/dev/null 2>&1; then
    docker network create --label "dev.quantself.release-slot=$slot" "$network" >/dev/null
  fi
  [[ "$(docker network inspect -f '{{index .Labels "dev.quantself.release-slot"}}' "$network")" == "$slot" ]]
  if ! docker inspect -f '{{json .NetworkSettings.Networks}}' quantself-postgres |
    jq -e --arg network "$network" '.[$network].Aliases | index("postgres")' >/dev/null; then
    docker network connect --alias postgres "$network" quantself-postgres
  fi
  [[ "$(docker inspect -f '{{.State.Health.Status}}' quantself-postgres)" == healthy ]]

  local base=(docker compose --project-name quantself --project-directory "$dir" --env-file "$deploy_path/.env" \
    -f "$dir/compose.yaml" -f "$dir/compose.prod.yaml" -f "$dir/compose.home.yaml")
  "${base[@]}" --profile '*' config --format json |
    jq -e --arg project "quantself-$slot" --arg network "$network" --arg image "$image" \
      --argjson port "$(web_port "$slot")" --arg origin "$origin" -f "$source_tree/scripts/promote-home-compose.jq" > "$dir/runtime.next"
  mv -fT "$dir/runtime.next" "$dir/runtime.json"
  slot_compose "$slot" --profile '*' config --quiet

  local run=(run --rm --no-deps --interactive=false --no-TTY)
  for inspector in api app; do
    # shellcheck disable=SC2016 # These variables belong to the container.
    slot_compose "$slot" "${run[@]}" --entrypoint sh "$inspector" -ec '
      case "$1" in
        api) path="${QUANTSELF_JOBS_EMAIL_ROUTES:?}" ;;
        app) path="${QUANTSELF_JOBS_HOME:?}/candidate-rules.json" ;;
      esac
      test -f "$path" && test ! -L "$path" && test -r "$path" && : < "$path"
    ' sh "$inspector" >/dev/null
  done
  slot_compose "$slot" "${run[@]}" --entrypoint bun api scripts/check-jobs-resume-templates.ts >/dev/null
  slot_compose "$slot" "${run[@]}" --entrypoint /app/apps/web/node_modules/.bin/codex \
    inventory-codex-enrichment-worker login status >/dev/null
  slot_compose "$slot" "${run[@]}" migrate
  slot_compose "$slot" up --detach --no-build --pull never --no-deps app api gateway
  slot_compose "$slot" --profile inventory-preprocessing create --no-build --pull never \
    api-workers inventory-codex-enrichment-worker inventory-preprocessing-worker
  for service in app api api-workers inventory-codex-enrichment-worker inventory-preprocessing-worker; do
    [[ "$(docker inspect -f '{{.Image}}' "$(container "$slot" "$service")")" == "$image" ]] ||
      fail "Unexpected candidate image running for $service."
  done
  ready "$slot"
}

active=legacy
prior=
if [[ -e "$state/active" ]]; then
  read_slots "$state/active" || fail "Invalid Keep active release state."
  active="${slots[0]}"
  prior="${slots[1]}"
fi

if [[ -e "$state/pending" ]]; then
  [[ "$action" == recover ]] || fail "An interrupted Keep release requires recovery."
  read_slots "$state/pending" || fail "Invalid pending Keep release state."
  if [[ "$active" == "${slots[0]}" ]]; then
    # The active pointer is committed only after all handoff checks succeeded.
    smoke
  else
    recover "${slots[1]}" "${slots[0]}"
  fi
  rm "$state/pending"
  sync -f "$state"
  exit
fi
[[ "$action" != recover ]] || exit 0
cmp -s "$ingress" <(render_routes "$active") ||
  fail "Keep ingress config differs from the active release state."

if [[ "$action" == promote ]]; then
  revision="$3" image="$4"
  [[ "$revision" =~ ^[0-9a-f]{40}$ && "$image" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    fail "Invalid verified release identifiers."
  [[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$revision" ]] ||
    fail "Loaded image does not match the verified revision."
  if [[ "$active" != legacy && "$(cat "$state/$active/release")" == "$revision"$'\n'"$image" ]]; then
    smoke
    exit
  fi
  target=blue
  if [[ "$active" == blue ]]; then target=green; fi
  if [[ "$target" == "$prior" ]]; then write_slots "$state/active" "$active" ""; fi
  cleanup_inactive_slot() {
    local status="$?"
    trap - EXIT
    if (( status != 0 )) && [[ -f "$state/$target/runtime.json" ]]; then
      slot_compose "$target" --profile '*' down --remove-orphans || true
    fi
    exit "$status"
  }
  trap cleanup_inactive_slot EXIT
  stage "$target" "$revision" "$image"
  trap - EXIT
else
  [[ -n "$prior" ]] || fail "No retained previous Keep release."
  target="$prior"
  if [[ "$action" == rollback-verified ]]; then verify_rollback_target "${@:3}"; fi
fi

write_slots "$state/pending" "$target" "$active"
switch_failed() {
  local status="$?"
  trap - EXIT
  if (( status != 0 )); then
    set +e
    (set -e; recover "$active" "$target")
    local recovery_status="$?"
    if (( recovery_status == 0 )); then
      rm "$state/pending"
      sync -f "$state"
      echo "Keep switch failed and the prior release was restored." >&2
    else
      echo "Keep switch failed. Run recover under the production lock." >&2
    fi
  fi
  exit "$status"
}
trap switch_failed EXIT

if [[ "$action" == rollback || "$action" == rollback-verified ]]; then
  if [[ "$target" == legacy ]]; then stop_background "$active"; fi
  start_containers "$target" api app gateway
  ready "$target"
fi
set_routes "$target"
smoke
echo "Keep ingress switched to $target."
stop_background "$active"
stop_http "$active"
start_background "$target"
smoke
write_slots "$state/active" "$target" "$active"
trap - EXIT
rm "$state/pending"
sync -f "$state"
echo "Keep release handoff complete."
