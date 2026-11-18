#!/bin/sh
set -eu
umask 077
root=/opt/quantself-roundcube/browser/release
runtime=/run/quantself-roundcube

[ "$(/usr/bin/findmnt -n -o FSTYPE --target "$runtime")" = tmpfs ]
# Require the unit's swap restriction or a host without active swap.
group=$(/usr/bin/awk -F: '$1 == "0" {print $3}' /proc/self/cgroup)
swap_limit="/sys/fs/cgroup${group%/}/memory.swap.max"
if [ "$(/usr/bin/wc -l < /proc/swaps)" -ne 1 ]; then
    [ -r "$swap_limit" ] && [ "$(/usr/bin/cat "$swap_limit")" = 0 ] || exit 1
fi
[ -r "$CREDENTIALS_DIRECTORY/des-key" ]
[ "$(/usr/bin/wc -c < "$CREDENTIALS_DIRECTORY/des-key")" -eq 32 ]
install -d -m 0700 "$runtime/tmp" "$runtime/logs" "$runtime/session" "$runtime/spool"
exec php "$root/bin/initdb.sh" --dir "$root/SQL" --update
