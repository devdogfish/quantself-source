#!/usr/bin/env bash
set -euo pipefail

origin="${1%/}"
curl_options=(--fail --silent --show-error --retry 12 --retry-all-errors --retry-delay 5)
if [[ -n "${QUANTSELF_PRODUCTION_HTTPS_IP:-}" ]]; then
  [[ "$origin" =~ ^https://([a-zA-Z0-9.-]+)$ ]]
  curl_options+=(--noproxy '*' --resolve "${BASH_REMATCH[1]}:443:$QUANTSELF_PRODUCTION_HTTPS_IP")
fi
# CI runs on the VM through restricted SSH and has no Owner device proof.
status="$(curl "${curl_options[@]}" --output /dev/null --write-out '%{http_code}' "$origin/api/health")"
[[ "$status" == 200 ]] || { echo "Expected API health 200, got $status." >&2; exit 1; }
