#!/usr/bin/env bash
set -euo pipefail

# Run checks in the supervisor's admitted, disposable checkout as its build user.
if (( $# > 1 )); then
  echo 'Usage: verify-atlas.sh [SOURCE_CHECKOUT]' >&2
  exit 2
fi
checkout=${1-$(dirname -- "${BASH_SOURCE[0]}")/../..}
cd -- "$checkout"

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'Atlas verification requires Linux x86_64.' >&2
  exit 2
fi

run() {
  env -i "HOME=$HOME" "PATH=$PATH" \
    DATABASE_URL=postgresql://unused:unused@127.0.0.1:59999/unused \
    NEXT_TELEMETRY_DISABLED=1 TZ=America/Halifax "$@"
}

if [[ $(run bun --version) != 1.3.14 ]]; then
  echo 'Atlas verification requires Bun 1.3.14.' >&2
  exit 2
fi

run bun install --frozen-lockfile

failed=0
# The hosted scopes can each use most of the Atlas guest's memory (6 GiB).
for scope in web server scripts; do
  if ! run env NODE_OPTIONS=--max-old-space-size=5632 bash scripts/ci/typecheck.sh tsc "$scope"; then
    echo "Typecheck failed ($scope)." >&2
    failed=1
  fi
done

run bun run --cwd packages/db generate

# Use the repository's short-lived test workers to limit Bun subprocess stalls.
# The outer deadline also covers a Bun event loop that stops honoring test timers.
if ! run timeout --kill-after=15s 12m bun run test; then
  echo 'Atlas tests failed or exceeded the time limit.' >&2
  failed=1
fi

exit "$failed"
