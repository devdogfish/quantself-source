#!/usr/bin/env bash

set -euo pipefail

env_file="${1:-.env}"

if [[ ! -f "$env_file" ]]; then
  echo "Inventory worker config check failed: $env_file is missing." >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  local value

  if [[ -n "${!key:-}" ]]; then
    printf "%s" "${!key}"
    return
  fi

  value="$(
    sed -n "s/^${key}=//p" "$env_file" |
      tail -n 1
  )"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  printf "%s" "$value"
}

girke_token="$(read_env_value GIRKE_API_TOKEN)"
girke_base_url="$(read_env_value GIRKE_API_BASE_URL)"
preprocessing_secret="$(read_env_value INVENTORY_PREPROCESSING_WORKER_SECRET)"
enrichment_secret="$(read_env_value INVENTORY_ENRICHMENT_WORKER_SECRET)"

if [[ "${QUANTSELF_DEPLOY_TARGET:-}" != home ]]; then
  if [[ ! "$girke_base_url" =~ ^https?://[^/]+(/.*)?$ ]]; then
    echo "Inventory worker config check failed: GIRKE_API_BASE_URL must be an HTTP(S) URL." >&2
    exit 1
  fi

  if [[ ${#girke_token} -lt 16 || "$girke_token" == "change-me" ]]; then
    echo "Inventory worker config check failed: GIRKE_API_TOKEN is missing or unsafe." >&2
    exit 1
  fi
fi

for secret_name in \
  INVENTORY_PREPROCESSING_WORKER_SECRET \
  INVENTORY_ENRICHMENT_WORKER_SECRET; do
  secret="$(read_env_value "$secret_name")"

  if [[ ${#secret} -lt 32 || "$secret" == "change-me" ]]; then
    echo "Inventory worker config check failed: $secret_name must be a unique secret of at least 32 characters." >&2
    exit 1
  fi
done

if [[ "$preprocessing_secret" == "$enrichment_secret" ]]; then
  echo "Inventory worker config check failed: worker secrets must differ." >&2
  exit 1
fi

echo "Inventory worker configuration is present and non-placeholder."
