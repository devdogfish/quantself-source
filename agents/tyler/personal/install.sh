#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

[[ $# == 2 ]] || { printf '%s\n' 'Usage: bash install.sh TYLER_TAILSCALE_IPV4 PERSONAL_BOT_HQ_MCP_URL' >&2; exit 1; }
[[ $EUID == 0 && $(hostname -s) == tyler && $(cat /etc/hermes/quantself-agent) == tyler ]] ||
  { printf '%s\n' 'Run on the approved Tyler host as root.' >&2; exit 1; }
! systemctl is-active --quiet hermes-personal.service ||
  { printf '%s\n' 'Stop the existing personal gateway before changing its managed configuration.' >&2; exit 1; }
grep -Fxq "$1" < <(tailscale ip -4) ||
  { printf '%s\n' 'The requested address is not assigned to Tyler.' >&2; exit 1; }

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
stage=$(mktemp -d)
trap 'find "$stage" -maxdepth 1 -type f -delete; rmdir "$stage"' EXIT
python3 -IB "$here/render.py" "$1" "$2" "$stage"
commit=3b421578588243f920886e6fe79a6faa87ea026e
runtime=/var/lib/quantself-tyler-personal
profile=$runtime/.hermes
source=$profile/hermes-agent

if ! getent passwd hermes-personal >/dev/null; then
  useradd --system --user-group --home-dir "$runtime" --shell /usr/sbin/nologin hermes-personal
fi
[[ $(getent passwd hermes-personal | cut -d: -f6,7) == "$runtime:/usr/sbin/nologin" &&
   $(id -u hermes-personal) != 0 && $(id -u hermes-personal) != "$(id -u hermes)" &&
   $(id -gn hermes-personal) == hermes-personal &&
   $(passwd -S hermes-personal | awk '{print $2}') == L ]] ||
  { printf '%s\n' 'The Personal Assistant service account is unsuitable.' >&2; exit 1; }
[[ ! -L "$runtime" && ! -L "$profile" && ! -L "$source" && ! -L /etc/hermes-personal ]] ||
  { printf '%s\n' 'A Personal Assistant path is a symlink.' >&2; exit 1; }
install -d -o hermes-personal -g hermes-personal -m 0700 "$runtime" "$profile"
as_personal() {
  runuser -u hermes-personal -- env -i HOME="$runtime" USER=hermes-personal HERMES_HOME="$profile" \
    PATH=/usr/local/bin:/usr/bin:/bin GIT_TERMINAL_PROMPT=0 "$@"
}
as_personal touch "$profile/.no-bundled-skills"
if [[ ! -x "$source/.hermes/bin/hermes" || $(as_personal git -C "$source" rev-parse HEAD) != "$commit" ]]; then
  curl --fail --silent --show-error --location --proto '=https' \
    "https://raw.githubusercontent.com/NousResearch/hermes-agent/$commit/scripts/install.sh" -o "$stage/bootstrap.sh"
  as_personal bash -s -- --commit "$commit" --dir "$source" --hermes-home "$profile" --non-interactive < "$stage/bootstrap.sh"
fi
[[ $(as_personal git -C "$source" rev-parse HEAD) == "$commit" &&
   $(as_personal "$source/.hermes/bin/hermes" --version </dev/null) == "Hermes Agent v0.23.1 "* ]]
install -d -o root -g hermes-personal -m 0750 /etc/hermes-personal
install -o root -g hermes-personal -m 0640 "$stage/config.yaml" /etc/hermes-personal/config.yaml
install -o root -g root -m 0600 "$stage/gateway.env" /etc/hermes-personal/gateway.env
install -o root -g root -m 0644 "$here/hermes-personal.service" /etc/systemd/system/hermes-personal.service
systemctl daemon-reload
printf '%s\n' 'Pinned personal gateway staged. Credentials and Owner-approved activation are separate steps.'
