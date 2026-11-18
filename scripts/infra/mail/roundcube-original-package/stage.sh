#!/usr/bin/env bash
set -euo pipefail

dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
stage="${1:-}"
if [[ $# != 1 || $stage != /* || -e "$stage" || -L "$stage" ]]; then
    printf '%s\n' 'Usage: stage.sh NEW_ABSOLUTE_DIRECTORY' >&2
    exit 2
fi
mkdir -m 0755 -- "$stage"
plugin="$stage/plugins/quantself_original"
install -d -m 0755 -- "$plugin" "$stage/config"
install -m 0644 -- "$dir/quantself_original.php" "$dir/../roundcube-reference/verify.php" \
    "$dir/../roundcube-reference/mailbox.php" "$dir/../roundcube-http-fixture/bounded_imap.php" "$plugin/"
install -m 0644 -- "$dir/quantself-original.inc.php.example" "$stage/config/"
