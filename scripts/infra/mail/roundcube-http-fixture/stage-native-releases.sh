#!/usr/bin/env bash
set -euo pipefail
readonly primary=F3E4C04BB3DB5D4215C45F7F5AB2BAA141C4F7D5
readonly signer=8970E37A698AF775D87D590DC2946A9609CD56B4
readonly dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
plan=${QS_ROUNDCUBE_FIXTURE_RELEASE_PLAN:-}
if [[ $1 == --check-plan ]]; then
    plan="${2:?Missing release plan}"
fi
review_command=(python3 -B "$dir/../roundcube_reviewed_releases.py")
if [[ -n ${QS_ROUNDCUBE_FIXTURE_REVIEWED_RELEASE:-} ]]; then
    review_command+=(--review "$QS_ROUNDCUBE_FIXTURE_REVIEWED_RELEASE")
fi
if [[ -n "$plan" ]]; then
    review_command+=(--plan "$plan")
fi
pins=$("${review_command[@]}")
if [[ $1 == --check-plan ]]; then
    exit
fi
readonly inputs="$1" state="$2"
mkdir -m 0755 "$state/native-releases"
mkdir -m 0700 "$state/release-gnupg"
mkdir -m 0700 "$state/release-inputs"
gpg --no-options --homedir "$state/release-gnupg" --batch --dearmor \
    --output "$state/release-gnupg/roundcube.gpg" "$inputs/pubkey.asc"

stage_release() {
    local version="$1" sha="$2" signed_sha="$3" archive root status
    archive="$state/release-inputs/roundcubemail-$version-complete.tar.gz"
    root="$state/native-releases/$version"
    cp "$inputs/${archive##*/}" "$inputs/${archive##*/}.asc" "$state/release-inputs/"
    printf '%s  %s\n' "$sha" "$archive" | shasum -a 256 -c
    printf '%s  %s.asc\n' "$signed_sha" "$archive" | shasum -a 256 -c
    status=$(gpgv --homedir "$state/release-gnupg" --keyring roundcube.gpg --status-fd 1 "$archive.asc" "$archive")
    awk -v signer="$signer" -v primary="$primary" \
        '$2 == "VALIDSIG" && $3 == signer && $NF == primary { valid++ } END { exit valid != 1 }' <<< "$status"

    mkdir -m 0755 "$root"
    tar -xzf "$archive" -C "$root" --strip-components=1
    test -f "$root/public_html/index.php"
    test ! -e "$root/plugins/quantself_original"
    cp -R "$state/stage/plugins/quantself_original" "$root/plugins/"
    cat > "$root/config/config.inc.php" <<'PHP'
<?php
$config['db_dsnw'] = 'sqlite:////native-runtime/roundcube.sqlite';
$config['des_key'] = 'fixture-only-native-key!';
$config['plugins'] = ['quantself_original'];
$config['log_driver'] = 'stdout';
$config['temp_dir'] = '/tmp';
$config['enable_installer'] = false;
require '/native-fixture/package-config.php';
PHP
    printf 'PASS staged signed Roundcube %s with reviewed plugin\n' "$version"
}

versions=()
while read -r version archive_sha signature_sha; do
    stage_release "$version" "$archive_sha" "$signature_sha"
    versions+=("$version")
done <<< "$pins"
printf '%s %s\n' "${versions[@]}" > "$state/native-release-pair"
