#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  echo "Usage: $0 <staging-directory>" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$1"/relay "$1"/scripts/website-analytics
cp "$root"/compose.analytics{,.live,.home}.yaml "$1/"
cp "$root"/scripts/website-analytics/{reader,retention}.sql "$1"/scripts/website-analytics/
bun build --target=bun --minify --outfile="$1/relay/relay.js" "$root/apps/api/src/website-analytics-standalone.ts"
