#!/usr/bin/env bash
set -euo pipefail

compiler=${1:-tsc}
case "$compiler" in
  tsc) command=(bun x --no-install tsc) ;;
  tsgo) command=(bun x --package @typescript/native-preview@7.0.0-dev.20260707.2 tsgo) ;;
  *) echo "Unknown compiler: $compiler" >&2; exit 2 ;;
esac

root=$(git rev-parse --show-toplevel)
cd "$root"
cache="$root/.cache/ci/typecheck/$compiler"
mkdir -p "$cache"

SECONDS=0
bun run --cwd packages/db generate

project() {
  local directory=$1
  local config=${2:-tsconfig.json}
  local name=${directory//\//-}
  echo "Checking $directory with $compiler"
  (cd "$directory" && time "${command[@]}" -p "$config" --noEmit --incremental --tsBuildInfoFile "$cache/$name.tsbuildinfo")
}

web() {
  bun run --cwd apps/web generate:api-client
  (cd apps/web && bun x --no-install next typegen)
  project apps/web tsconfig.typecheck.json
}
server() {
  project apps/api
  project packages/db
  project packages/auth
}
scripts() {
  project packages/cli
  project scripts/jobs
  project scripts/originals
}

scope=${2:-all}
case "$scope" in
  web|server|scripts) "$scope" ;;
  all)
    web & web_pid=$!
    server & server_pid=$!
    scripts & scripts_pid=$!
    failed=0
    for pid in "$web_pid" "$server_pid" "$scripts_pid"; do
      wait "$pid" || failed=1
    done
    echo "$compiler typecheck ($scope, including generation): ${SECONDS}s"
    exit "$failed"
    ;;
  *) echo "Unknown typecheck scope: $scope" >&2; exit 2 ;;
esac
echo "$compiler typecheck ($scope, including generation): ${SECONDS}s"
