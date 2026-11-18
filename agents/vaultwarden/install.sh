#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

agent_vault_user=quantself-vaultwarden
agent_vault_state=/var/lib/quantself-vaultwarden
agent_vault_config=/etc/quantself-vaultwarden
agent_vault_libexec=/usr/local/libexec/quantself-vaultwarden
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

uuid_pattern='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
mail_item=${3:-}
self_service=${4:-}
if [[ $# -lt 2 || $# -gt 4 || ! "$1" =~ $uuid_pattern || ! -f "$2" ||
      ( $# -ge 3 && ! "$mail_item" =~ $uuid_pattern ) ||
      ( $# == 4 && "$self_service" != --self-service ) ]]; then
  printf '%s\n' "Usage: $0 STARTUP_FOLDER_UUID SITES.json [BUSINESS_MAIL_ITEM_UUID [--self-service]]" >&2
  exit 1
fi
if [[ $EUID != 0 || ! -d /run/systemd/system ]] || ! getent passwd hermes >/dev/null; then
  printf '%s\n' "Run as root on the dedicated systemd Agent host with its locked hermes account" >&2
  exit 1
fi
if [[ -n "$mail_item" ]]; then
  role=$(cat /etc/hermes/quantself-agent 2>/dev/null || true)
  case "$role" in
    tyler|stacy|sam) ;;
    *) printf '%s\n' "Business mail requires an installed Tyler, Stacy or Sam role" >&2; exit 1 ;;
  esac
  if ! python3 -IB -c 'import json, sys; sites = json.load(open(sys.argv[1])); sys.exit(not isinstance(sites, dict) or sys.argv[2] in sites)' "$2" "$mail_item"; then
    printf '%s\n' "Business mail requires a separate Vaultwarden item from all website recipes" >&2
    exit 1
  fi
fi
PATH=/usr/local/bin:/usr/bin:/bin command -v bw >/dev/null
if ! getent passwd "$agent_vault_user" >/dev/null; then
  useradd --system --user-group --home-dir "$agent_vault_state" --shell /usr/sbin/nologin "$agent_vault_user"
fi
account=$(getent passwd "$agent_vault_user")
IFS=: read -r _ _ vault_uid vault_gid _ vault_home vault_shell <<< "$account"
if [[ "$vault_uid" == 0 || "$vault_uid" == "$(id -u hermes)" || "$vault_home" != "$agent_vault_state" ||
      "$vault_shell" != /usr/sbin/nologin || "$vault_gid" != "$(getent group "$agent_vault_user" | cut -d: -f3)" ]]; then
  printf '%s\n' "Existing Vaultwarden service account is unsuitable" >&2
  exit 1
fi
if systemctl is-active --quiet quantself-vaultwarden.socket ||
   systemctl is-active --quiet quantself-vaultwarden.service; then
  printf '%s\n' "Stop the Agent's Vaultwarden socket and service before applying an update" >&2
  exit 1
fi

install -d -o "$agent_vault_user" -g "$agent_vault_user" -m 0700 "$agent_vault_state" "$agent_vault_state/bw"
install -d -o root -g root -m 0700 "$agent_vault_config"
install -d -o root -g root -m 0755 "$agent_vault_libexec"
{
  printf 'VAULTWARDEN_STARTUP_FOLDER=%s\nVAULTWARDEN_SITES=%s/sites.json\n' "$1" "$agent_vault_config"
  if [[ -n "$mail_item" ]]; then
    printf 'VAULTWARDEN_MAIL_ITEM=%s\nVAULTWARDEN_MAIL_USERNAME=%s@dawnshiftagency.com\n' "$mail_item" "$role"
  fi
  if [[ -n "$self_service" ]]; then
    printf 'VAULTWARDEN_SELF_SERVICE=%s\n' "$role"
  fi
} > "$agent_vault_config/settings"
# The service user can read the root-owned recipes but cannot change them or access the encrypted credential file.
chown root:"$agent_vault_user" "$agent_vault_config"
chmod 0710 "$agent_vault_config"
install -o root -g "$agent_vault_user" -m 0640 "$2" "$agent_vault_config/sites.json"
install -o root -g root -m 0755 "$source_dir/service.py" "$source_dir/browser.py" \
  "$source_dir/cookies.py" "$source_dir/mail.py" "$source_dir/self_service.py" \
  "$source_dir/self_service_browser.py" "$source_dir/origin_proxy.py" "$agent_vault_libexec/"
runtime_venv="$agent_vault_libexec/venv"
(
  umask 022
  python3 -m venv "$runtime_venv"
  "$runtime_venv/bin/python" -m pip --isolated install --only-binary=:all: --no-deps \
    -r "$source_dir/requirements.txt"
)
# Repair runtimes created with the installer's private umask on earlier runs.
chown -hR root:root "$runtime_venv"
find "$runtime_venv" \( -type d -o -type f \) -exec chmod go=rX {} +
runuser -u "$agent_vault_user" -- "$runtime_venv/bin/python" -I -B -c 'from playwright.async_api import async_playwright'
install -o root -g root -m 0755 "$source_dir/keys.py" /usr/local/libexec/quantself-vaultwarden-keys
install -o root -g root -m 0644 "$source_dir/quantself-vaultwarden.service" \
  "$source_dir/quantself-vaultwarden.socket" /etc/systemd/system/
systemctl daemon-reload
