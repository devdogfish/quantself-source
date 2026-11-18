#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mail_reader="$here/../../vaultwarden/mail.py"
libexec=/usr/local/libexec/quantself-jobs-mail
units=/etc/systemd/system
die() { printf '%s\n' "$*" >&2; exit 1; }

[[ $(uname -s) == Linux && $EUID == 0 && -d /run/systemd/system ]] || die 'Run as root on Sam’s systemd host.'
[[ -f /etc/hermes/quantself-agent && $(cat /etc/hermes/quantself-agent) == sam ]] || die 'This host is not Sam’s.'
[[ $(id -gn hermes) == hermes ]] || die 'Sam’s dedicated hermes user and group are required.'

if ! getent passwd quantself-jobs-mail >/dev/null; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin quantself-jobs-mail
fi
install -d -o root -g root -m 0755 -- "$libexec"
install -d -o root -g root -m 0700 -- /etc/quantself-jobs-mail
install -o root -g root -m 0644 -- "$here/jobs_mail_service.py" "$here/jobs_mail_actions.py" \
  "$here/jobs_mail_reply.py" "$mail_reader" "$libexec/"
if [[ -n "${1:-}" ]]; then
  install -o root -g quantself-jobs-mail -m 0640 -- "$1" "$libexec/send-reply.js"
fi
install -o root -g root -m 0644 -- \
  "$here/quantself-jobs-mail.socket" "$here/quantself-jobs-mail@.service" "$units/"
systemctl daemon-reload
printf '%s\n' 'Jobs inbox units installed. Qualify the encrypted credentials and mailbox actions before enabling the socket.'
