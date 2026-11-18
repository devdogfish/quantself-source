#!/usr/bin/env bash
set -euo pipefail

readonly commit=1a6635100bb18c7184441f9230a8379e6e7b3e39
readonly image=docker.io/library/php@sha256:b9014f1cc1983827459faed83b315a40ead9860bdadefc042b31f1540ef8c746
readonly fixture_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT

for path in program/include/rcmail.php \
    program/lib/Roundcube/rcube_plugin_api.php program/lib/Roundcube/rcube_message.php; do
    curl -q --fail --silent --show-error --location --proto '=https' --max-time 30 \
        "https://raw.githubusercontent.com/roundcube/roundcubemail/$commit/$path" \
        --output "$work_dir/${path##*/}"
done

if command -v php >/dev/null; then
    php -n "$fixture_dir/roundcube-guard-fixture.php" "$work_dir"
else
    context="${ROUNDCUBE_FIXTURE_DOCKER_CONTEXT:-$(docker context show)}"
    endpoint=$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}')
    if [[ "$endpoint" != unix:///* ]]; then
        printf '%s\n' 'Use PHP CLI or a local Unix-socket Docker context.' >&2
        exit 1
    fi
    cp "$fixture_dir/roundcube-guard-fixture.php" "$work_dir/fixture.php"
    docker --context "$context" run --rm --network none --read-only --cap-drop ALL \
        --mount "type=bind,src=$work_dir,dst=/fixture,readonly" \
        "$image" php -n /fixture/fixture.php /fixture
fi
