#!/usr/bin/env bash
# Atomically replace only our table, preserving Docker and Tailscale tables.
set -euo pipefail
candidate=$(mktemp)
trap 'rm -f -- "$candidate"' EXIT
if nft list table inet keep_storage_boundary >/dev/null 2>&1; then
  printf 'delete table inet keep_storage_boundary\n' > "$candidate"
fi
cat /etc/keep-storage/guest-firewall.nft >> "$candidate"
nft -c -f "$candidate"
nft -f "$candidate"
