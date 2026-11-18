#!/usr/bin/env bash
set -euo pipefail
candidate=$(mktemp)
trap 'rm -f -- "$candidate"' EXIT
if nft list table inet keep_storage_management_boundary >/dev/null 2>&1; then
  printf 'delete table inet keep_storage_management_boundary\n' > "$candidate"
fi
cat /etc/keep-storage-management.nft >> "$candidate"
nft -c -f "$candidate"
nft -f "$candidate"
