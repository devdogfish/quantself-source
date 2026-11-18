#!/usr/bin/env bash
# Give Keep's existing ingress a private reload socket before the first slot deploy.
set -Eeuo pipefail
umask 077

[[ "$(id -u)" == 0 && "$(hostname -s)" == quantself ]]
[[ "$#" == 1 && ( "$1" == prepare || "$1" == activate ) ]]
directory=/etc/quantself-ingress
active="$directory/Keep.Caddyfile"
template="$active.release-template"
unit=quantself-ingress.service
binary=/usr/local/libexec/quantself-caddy-spaceship-v1.2.0
dropin="/etc/systemd/system/$unit.d/40-release-reload.conf"
backup=/var/lib/quantself-atlas-keep/ingress-before-slots
[[ -f "$active" && ! -L "$active" && -x "$binary" ]]
systemctl is-active --quiet "$unit"

render() {
  awk '
    /^[[:space:]]*admin off[[:space:]]*$/ {
      ++admin
      print "\tadmin unix//run/quantself-ingress/admin.sock"
      next
    }
    /127\.0\.0\.1:3000([[:space:]]|$)/ { ++web }
    /127\.0\.0\.1:3001([[:space:]]|$)/ { ++jobs }
    { print }
    END { if (admin != 1 || web == 0 || jobs == 0) exit 2 }
  ' "$active"
}

validate() {
  local options=(--quiet --wait --pipe --collect --property=EnvironmentFile=/etc/quantself/ingress.env)
  systemd-run "${options[@]}" "$binary" validate --config "$1" --adapter caddyfile
}

if [[ "$1" == prepare ]]; then
  [[ ! -e "$template" && ! -L "$template" ]]
  scratch=$(mktemp "$directory/.release-template.XXXXXXXX")
  trap 'rm -f -- "$scratch"' EXIT
  render > "$scratch"
  chmod 0644 "$scratch"
  validate "$scratch"
  mv -T -- "$scratch" "$template"
  exit
fi

exec 9>>/run/lock/quantself-production.lock
flock -n 9
[[ ! -e /var/lib/keep-backup/production-maintenance.json && ! -L /var/lib/keep-backup/production-maintenance.json ]]
[[ -f "$template" && ! -L "$template" && ! -e "$backup" && ! -L "$backup" ]]
[[ ! -e "$dropin" && ! -L "$dropin" ]]
cmp -s -- "$template" <(render)
validate "$template"
tailnet_ip=$(tailscale ip -4)
[[ "$tailnet_ip" =~ ^100\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
health() {
  local options=(--silent --show-error --fail --max-time 3 --resolve "qs.girke.dev:443:$tailnet_ip")
  curl "${options[@]}" https://qs.girke.dev/api/health >/dev/null
}
wait_for_health() {
  local attempt
  for attempt in {1..10}; do
    if health; then return; fi
    sleep 1
  done
  return 1
}
health

install -d -m 0700 "$backup"
install -m 0644 "$active" "$backup/Keep.Caddyfile"
install -d -m 0755 "$(dirname "$dropin")"
scratch=$(mktemp "$directory/.release-activate.XXXXXXXX")
changed=0
restore() {
  status=$?
  trap - EXIT
  rm -f -- "$scratch"
  if ((status != 0 && changed)); then
    set +e
    rm -f -- "$dropin"
    install -m 0644 "$backup/Keep.Caddyfile" "$active"
    systemctl daemon-reload
    if systemctl restart "$unit" && wait_for_health; then
      echo "Restored previous ingress after failed bootstrap." >&2
    else
      echo "Ingress rollback needs immediate operator attention." >&2
    fi
  fi
  exit "$status"
}
trap restore EXIT

cat > "$scratch" <<'UNIT'
[Service]
RuntimeDirectory=quantself-ingress
RuntimeDirectoryMode=0700
ExecReload=
ExecReload=/usr/local/libexec/quantself-caddy-spaceship-v1.2.0 reload --address unix//run/quantself-ingress/admin.sock --config /etc/quantself-ingress/Keep.Caddyfile --adapter caddyfile
UNIT
changed=1
install -m 0644 "$scratch" "$dropin"
install -m 0644 "$template" "$active"
systemctl daemon-reload
systemctl restart "$unit"
[[ -S /run/quantself-ingress/admin.sock ]]
wait_for_health
systemctl reload "$unit"
health
echo "Keep ingress reload socket active. Original configuration saved."
