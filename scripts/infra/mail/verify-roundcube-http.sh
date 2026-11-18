#!/usr/bin/env bash
set -euo pipefail
if [[ ${QS_ROUNDCUBE_FIXTURE_DISPLAY:-0} == 1
    && ( ${QS_ROUNDCUBE_FIXTURE_PACKAGE:-} != 1 || ${1:-} != --joined-https ) ]]; then
    printf '%s\n' 'Use the staged plugin and --joined-https for the display proof.' >&2
    exit 1
fi
if [[ ${QS_ROUNDCUBE_FIXTURE_SOURCE:-0} == 1 ]]; then
    if [[ ${QS_ROUNDCUBE_FIXTURE_PACKAGE:-} != 1 || ${1:-} != --joined-https ]]; then
        printf '%s\n' 'Use the staged plugin and --joined-https for the source proof.' >&2
        exit 1
    fi
    export QS_ROUNDCUBE_FIXTURE_SPOOL=1
fi
if [[ ${QS_ROUNDCUBE_FIXTURE_SPOOL:-0} == 1 && ${1:-} != --joined-https ]]; then
    printf '%s\n' 'Use --joined-https for the attachment spool proof.' >&2
    exit 1
fi
if [[ -n ${QS_ROUNDCUBE_FIXTURE_PACKAGE:-} && ${1:-} != --joined-https ]]; then
    printf '%s\n' 'Use --joined-https for the staged plugin proof.' >&2
    exit 1
fi
if [[ ${QS_ROUNDCUBE_FIXTURE_SESSION_CONCURRENCY:-0} == 1 && ${QS_ROUNDCUBE_FIXTURE_PACKAGE:-} != 1 ]]; then
    printf '%s\n' 'Use the staged plugin and --joined-https for the session concurrency proof.' >&2
    exit 1
fi
case ${2:-} in
    --qualify-only|--revalidate-cutover)
        if [[ -z ${QS_ROUNDCUBE_FIXTURE_NATIVE_INPUTS:-} || -z ${QS_ROUNDCUBE_FIXTURE_RELEASE_PLAN:-}
            || ( ${2:-} == --qualify-only && -z ${QS_ROUNDCUBE_FIXTURE_QUALIFICATION_MANIFEST:-} )
            || ( ${2:-} == --revalidate-cutover && -z ${QS_ROUNDCUBE_FIXTURE_EXPECTED_MANIFEST:-} ) ]]; then
            printf '%s\n' 'Use the patch readiness checker with native inputs, a release plan and its manifest.' >&2
            exit 1
        fi
        ;;
    *)
        if [[ -n ${QS_ROUNDCUBE_FIXTURE_RELEASE_PLAN:-} ]]; then
            printf '%s\n' 'A saved release plan requires qualification or receipt revalidation before cutover.' >&2
            exit 1
        fi
        ;;
esac
if [[ -n ${QS_ROUNDCUBE_FIXTURE_NATIVE_INPUTS:-} ]]; then
    if [[ ${QS_ROUNDCUBE_FIXTURE_PACKAGE:-} != 1 || ${1:-} != --joined-https
        || ${QS_ROUNDCUBE_FIXTURE_SESSION_CONCURRENCY:-0} == 1 || ${QS_ROUNDCUBE_FIXTURE_DISPLAY:-0} == 1
        || ${QS_ROUNDCUBE_FIXTURE_SPOOL:-0} == 1 ]]; then
        printf '%s\n' 'Use the staged package and default --joined-https smoke test for the native upgrade proof.' >&2
        exit 1
    fi
    export QS_ROUNDCUBE_ACTIVE_UPSTREAM=roundcube
    export QS_ROUNDCUBE_CANDIDATE_PACKAGE=1
fi

readonly dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/roundcube-http-fixture" && pwd -P)"
context="${ROUNDCUBE_FIXTURE_DOCKER_CONTEXT:-$(docker context show)}"
endpoint=$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}')
if [[ "$endpoint" != unix:///* ]]; then
    printf '%s\n' 'Use a local Unix-socket Docker context.' >&2
    exit 1
fi

QS_ROUNDCUBE_FIXTURE_STATE=$(mktemp -d)
export QS_ROUNDCUBE_FIXTURE_STATE
trap 'rm -rf -- "$QS_ROUNDCUBE_FIXTURE_STATE"' EXIT
touch "$QS_ROUNDCUBE_FIXTURE_STATE/imap.log"

readonly project="qs-roundcube-http-$$-$RANDOM"
printf 'Roundcube fixture Compose project %s.\n' "$project" >&2
compose=(docker --context "$context" compose --env-file /dev/null --file "$dir/compose.yaml"
    --project-name "$project")
cleanup_fixture() {
    trap '' TERM INT
    # Keep the waiter in the supervised process group. Compose handles TERM
    # itself, so only its teardown command starts outside that signal group.
    if ! python3 -B - "${compose[@]}" down --volumes --remove-orphans <<'PY'
import subprocess
import sys

sys.exit(subprocess.call(sys.argv[1:], start_new_session=True))
PY
    then
        printf 'Roundcube fixture teardown failed for Compose project %s. Reconcile that project on the local runner.\n' "$project" >&2
        exit 1
    fi
    rm -rf -- "$QS_ROUNDCUBE_FIXTURE_STATE"
}
trap cleanup_fixture EXIT
if [[ ${1:-} == --joined || ${1:-} == --joined-https || ${1:-} == --prepare-joined ]]; then
    repo=$(cd -- "$dir/../../../.." && pwd)
    lock=$(shasum -a 256 "$repo/bun.lock" | cut -c1-12)
    export QS_ROUNDCUBE_JOINED_IMAGE="quantself-roundcube-joined:$lock"
    compose+=(--file "$dir/joined.compose.yaml")
    if [[ $1 != --joined ]]; then
        compose+=(--file "$dir/joined-https.compose.yaml")
    fi
    if [[ -n ${QS_ROUNDCUBE_FIXTURE_PACKAGE:-} ]]; then
        "$dir/../roundcube-original-package/stage.sh" "$QS_ROUNDCUBE_FIXTURE_STATE/stage"
        compose+=(--file "$dir/package.compose.yaml")
    fi
    if [[ -n ${QS_ROUNDCUBE_FIXTURE_NATIVE_INPUTS:-} ]]; then
        bash "$dir/stage-native-releases.sh" "$QS_ROUNDCUBE_FIXTURE_NATIVE_INPUTS" "$QS_ROUNDCUBE_FIXTURE_STATE"
        read -r QS_ROUNDCUBE_FIXTURE_NATIVE_PRIOR QS_ROUNDCUBE_FIXTURE_NATIVE_CANDIDATE \
            < "$QS_ROUNDCUBE_FIXTURE_STATE/native-release-pair"
        export QS_ROUNDCUBE_FIXTURE_NATIVE_PRIOR QS_ROUNDCUBE_FIXTURE_NATIVE_CANDIDATE
        compose+=(--file "$dir/native-release.compose.yaml")
        if [[ ${2:-} == --qualify-only || ${2:-} == --revalidate-cutover ]]; then
            python3 - "$QS_ROUNDCUBE_FIXTURE_STATE/native-releases/$QS_ROUNDCUBE_FIXTURE_NATIVE_CANDIDATE/plugins/quantself_original" \
                "${QS_ROUNDCUBE_FIXTURE_EXPECTED_MANIFEST:-}" > "$QS_ROUNDCUBE_FIXTURE_STATE/plugin-manifest.json" <<'PY'
from hashlib import sha256
import json
from pathlib import Path
import sys

plugin = Path(sys.argv[1])
names = ("bounded_imap.php", "mailbox.php", "quantself_original.php", "verify.php")
manifest = {name: sha256((plugin / name).read_bytes()).hexdigest() for name in names}
if sys.argv[2] and manifest != json.loads(Path(sys.argv[2]).read_text()):
    sys.exit("Staged plugin bytes differ from the saved qualification receipt")
print(json.dumps(manifest, sort_keys=True))
PY
        fi
    fi
    if [[ $1 == --prepare-joined ]]; then
        DOCKER_CONTEXT="$context" "$repo/scripts/proofs/private-ocr/run.sh" --prepare
        docker --context "$context" build --pull=false --build-arg "BASE=quantself-private-ocr-fixture:$lock" \
            -t "$QS_ROUNDCUBE_JOINED_IMAGE" - <<'DOCKER'
ARG BASE
FROM oven/bun:1.3.14-alpine AS switch
RUN apk add --no-cache su-exec=0.2-r3
FROM ${BASE}
COPY --from=switch /sbin/su-exec /sbin/su-exec
COPY --from=switch /lib/ld-musl-*.so.1 /lib/
DOCKER
        "${compose[@]}" pull imap-fixture roundcube http-proof postgres edge
        exit
    fi
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
        -addext subjectAltName=DNS:localhost,DNS:imap-fixture -keyout "$QS_ROUNDCUBE_FIXTURE_STATE/imap.key" \
        -out "$QS_ROUNDCUBE_FIXTURE_STATE/imap.crt" >/dev/null 2>&1
    git -C "$repo" archive HEAD apps/api/src apps/web/lib packages/auth packages/budgeting packages/db \
        automation/n8n/jobs-feed/sources scripts > "$QS_ROUNDCUBE_FIXTURE_STATE/source.tar"
    "${compose[@]}" up -d --wait --pull never postgres imap-fixture
    for ((attempt = 0; attempt < 60; attempt++)); do
        if "${compose[@]}" logs --no-log-prefix imap-fixture | grep -qx 'joined observer ready'; then break; fi
        sleep 0.25
    done
    "${compose[@]}" logs --no-log-prefix imap-fixture | grep -qx 'joined observer ready'
    "${compose[@]}" run --pull never --rm --no-deps issue-owner-reference
    if [[ $1 == --joined-https ]]; then
        openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=roundcube.jobs.example.test \
            -addext subjectAltName=DNS:roundcube.jobs.example.test \
            -keyout "$QS_ROUNDCUBE_FIXTURE_STATE/roundcube.key" \
            -out "$QS_ROUNDCUBE_FIXTURE_STATE/roundcube.crt" >/dev/null 2>&1
        "${compose[@]}" up -d --pull never roundcube edge
    else
        "${compose[@]}" up -d --pull never roundcube
    fi
else
    bun "$dir/mint-references.ts" "$QS_ROUNDCUBE_FIXTURE_STATE"
    "${compose[@]}" up -d imap-fixture roundcube
fi
proof_args=(run --rm --no-deps)
if [[ ${QS_ROUNDCUBE_FIXTURE_SESSION_CONCURRENCY:-0} == 1 ]]; then
    mkdir "$QS_ROUNDCUBE_FIXTURE_STATE/session-login"
    proof_args+=(--volume "$QS_ROUNDCUBE_FIXTURE_STATE/session-login:/session-login:rw"
        --env QS_ROUNDCUBE_FIXTURE_SESSION_CONCURRENCY=1)
fi
run_http_proof() {
    if ! "${compose[@]}" "${proof_args[@]}" "$@" http-proof; then
        "${compose[@]}" logs --no-color roundcube imap-fixture
        return 1
    fi
}
run_http_proof
if [[ -n ${QS_ROUNDCUBE_FIXTURE_NATIVE_INPUTS:-} ]]; then
    prior_containers=$("${compose[@]}" ps -q roundcube edge)
    candidate_args=(--env QS_ROUNDCUBE_FIXTURE_CANDIDATE=1 --env "QS_ROUNDCUBE_FIXTURE_RELEASE=$QS_ROUNDCUBE_FIXTURE_NATIVE_CANDIDATE")
    "${compose[@]}" run --pull never --rm --no-deps roundcube-snapshot
    QS_ROUNDCUBE_CANDIDATE_PACKAGE=wrong-key "${compose[@]}" up -d --pull never --no-deps roundcube-candidate
    if failed_smoke=$("${compose[@]}" "${proof_args[@]}" "${candidate_args[@]}" http-proof 2>&1); then
        printf '%s\n' 'Wrong-key candidate unexpectedly passed qualification' >&2
        exit 1
    elif [[ "$failed_smoke" != *'Expected signed-out stock login form, got 409'* ]]; then
        printf '%s\n' "$failed_smoke" >&2
        "${compose[@]}" logs --no-color roundcube-candidate
        exit 1
    fi
    run_http_proof
    printf '%s\n' 'PASS failed candidate blocked before promotion, previous release served the signed handoff'

    "${compose[@]}" up -d --pull never --force-recreate --no-deps roundcube-candidate
    run_http_proof "${candidate_args[@]}"
    run_http_proof
    test "$prior_containers" = "$("${compose[@]}" ps -q roundcube edge)"
    printf '%s\n' 'PASS candidate passed qualification on its SQLite clone while the prior release still served'

    if [[ ${2:-} == --qualify-only ]]; then
        (set -o noclobber; cat "$QS_ROUNDCUBE_FIXTURE_STATE/plugin-manifest.json" > "$QS_ROUNDCUBE_FIXTURE_QUALIFICATION_MANIFEST")
        exit
    fi

    python3 "$dir/native-cutover.py" "${compose[@]}"
fi
fault="${QS_ROUNDCUBE_FIXTURE_MID_FETCH:-0}"
if [[ "$fault" != 0 ]]; then
    peer_log=$("${compose[@]}" logs --no-color imap-fixture)
    if [[ "$peer_log" != *"IMAP injected FETCH fault $fault"* ]]; then
        printf '%s\n' 'The IMAP peer did not reach the fault injection point.' >&2
        exit 1
    fi
    printf '%s\n' 'Verified peer injected the selected FETCH fault'
    if [[ "$fault" == source-oversize ]]; then
        if [[ "$peer_log" != *"IMAP client closed before oversized literal was sent"* ]]; then
            printf '%s\n' 'Client did not reject the oversized declaration before reading.' >&2
            exit 1
        fi
        printf '%s\n' 'Verified client closed before reading the oversized literal'
    fi
fi
