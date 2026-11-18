#!/bin/sh
set -eu
path=/run/quantself-roundcube-inputs
[ "$(/usr/bin/findmnt -n -o FSTYPE --mountpoint "$path")" = tmpfs ]
options=$(/usr/bin/findmnt -n -o OPTIONS --mountpoint "$path")
case ",$options," in
    *,noswap,*) ;;
    *) exit 1 ;;
esac
[ "$(/usr/bin/stat -c %u:%a "$path")" = 0:700 ]
