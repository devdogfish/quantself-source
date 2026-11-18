#!/usr/bin/env bash
# Owner runs through the setup wizard. Password arrives via stdin, never argv.
set -euo pipefail
set +x
umask 077
[[ $EUID -eq 0 && $(hostname -s) == files ]] || exit 1
[[ ! -e /srv/opencloud/config/opencloud.yaml ]] || { echo 'Vault already initialized; refusing to overwrite credentials.'; exit 1; }
IFS= read -r IDM_ADMIN_PASSWORD
[[ ${#IDM_ADMIN_PASSWORD} -ge 20 ]] || { echo 'Use at least 20 characters.'; exit 1; }
export IDM_ADMIN_PASSWORD
cd /opt/keep-vault
docker compose -f compose.yaml run --rm -T -e IDM_ADMIN_PASSWORD opencloud init --insecure no --quiet
unset IDM_ADMIN_PASSWORD
docker compose -f compose.yaml up -d
echo 'Vault initialized. Keep your admin password in Proton Pass.'
