#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { printf '%s\n' "$*" >&2; exit 1; }

[[ $# == 4 ]] || die "Usage: $0 NEW_ABSOLUTE_STAGE_DIR API_HOST_UID SOCKET_HOST_GID IMAP_LEAF_SHA256"
stage=$1
api_uid=$2
socket_gid=$3
pin=$4
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

valid_id() {
  [[ $1 =~ ^[1-9][0-9]{0,9}$ ]] && (( $1 <= 4294967294 && $1 != 65535 ))
}

[[ $stage == /* && $stage != / ]] || die 'Use a new absolute staging directory.'
valid_id "$api_uid" || die 'Supply the non-root API UID as seen by the observer host.'
valid_id "$socket_gid" || die 'Supply the non-root socket GID as seen by the observer host.'
[[ $pin =~ ^[0-9a-f]{64}$ ]] || die 'Supply the verified lowercase SHA-256 of the IMAP leaf certificate DER.'
mkdir -m 0700 -- "$stage" || die 'The staging directory must be new.'

units="$stage/etc/systemd/system"
dropin="$units/quantself-roundcube-observer.socket.d"
config="$stage/etc/quantself-roundcube-observer"
libexec="$stage/usr/local/libexec/quantself-roundcube-observer"
install -d -m 0755 -- "$units" "$dropin" "$libexec"
install -d -m 0700 -- "$config"
install -m 0644 -- "$here/quantself-roundcube-observer.socket" "$here/quantself-roundcube-observer@.service" "$units/"
install -m 0644 -- "$here/../jobs_roundcube_observer.py" "$here/../roundcube_imap.py" \
  "$here/../jobs_mail_service.py" "$here/../jobs_mail_actions.py" "$here/../jobs_mail_reply.py" \
  "$here/../../../vaultwarden/mail.py" "$libexec/"
printf '[Socket]\nSocketGroup=%s\n' "$socket_gid" > "$dropin/10-api-group.conf"
chmod 0644 "$dropin/10-api-group.conf"
printf 'QUANTSELF_JOBS_ROUNDCUBE_PEER_UID=%s\nQUANTSELF_JOBS_ROUNDCUBE_IMAP_CERT_SHA256=%s\n' \
  "$api_uid" "$pin" > "$config/observer.env"
chmod 0600 "$config/observer.env"

printf '%s\n' 'Observer staged. The encrypted imap credential is supplied separately on the approved host.'
