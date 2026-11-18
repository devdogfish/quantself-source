#!/usr/bin/env bash

set -euo pipefail

env_file="${1:-.env}"

if [[ ! -r "$env_file" ]]; then
  echo "API foundation config check failed: $env_file is missing." >&2
  exit 1
fi

read_env_value() {
  local key="$1"
  local value

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

auth_secret="$(read_env_value BETTER_AUTH_SECRET)"
origin="$(read_env_value QUANTSELF_PUBLIC_ORIGIN)"
if [[ -z "$origin" ]]; then origin="$(read_env_value BETTER_AUTH_URL)"; fi
instance_name="$(read_env_value QUANTSELF_INSTANCE_NAME)"
owner_email="$(read_env_value QUANTSELF_OWNER_EMAIL)"

if [[ -n "$auth_secret" && (${#auth_secret} -lt 32 || "$auth_secret" == "change-me") ]]; then
  echo "API foundation config check failed: BETTER_AUTH_SECRET must contain at least 32 characters." >&2
  exit 1
fi

if [[ -z "${instance_name//[[:space:]]/}" ]]; then
  echo "API foundation config check failed: QUANTSELF_INSTANCE_NAME must not be empty." >&2
  exit 1
fi

if [[ ! "$owner_email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "API foundation config check failed: QUANTSELF_OWNER_EMAIL must be an email address." >&2
  exit 1
fi

if [[ ! "$origin" =~ ^https?://[^/]+/?$ ]]; then
  echo "API foundation config check failed: QUANTSELF_PUBLIC_ORIGIN must be one HTTP(S) origin without a path." >&2
  exit 1
fi

echo "API foundation authentication configuration is valid."
