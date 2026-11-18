#!/usr/bin/env bash
set -euo pipefail

gateway_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
caddy_image=caddy:2.11.4-alpine
tmp="$(mktemp -d)"
container=""
cleanup() {
  local status=$?
  if [[ -n "$container" ]]; then
    if [[ "$status" != 0 ]]; then docker logs "$container" >&2; fi
    docker rm -f "$container" >/dev/null
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

# Test the public edge over HTTP locally and substitute a trusted fixture certificate on Keep.
cp "$gateway_dir/"*.Caddyfile "$gateway_dir/"*.caddy "$tmp/"
{
  printf '{\n admin off\n}\n'
  sed 's@^hooks\.girke\.dev {@http://hooks.girke.dev:8080 {@' "$tmp/Hostinger.Caddyfile"
  printf '\nhttp://:8080 {\n respond 404\n}\n'
} > "$tmp/Hostinger.test"
sed -e 's@http://:8790@http://:8781@' -e 's@bind 127.0.0.1@bind 0.0.0.0@' \
  "$tmp/Gate.Funnel.Caddyfile" > "$tmp/Gate.Funnel.fixture"
awk '
  /tls \{/ {
    print "\ttls /fixture/ca.pem /fixture/key.pem"
    getline
    getline
    next
  }
  { print }
' "$tmp/Keep.Caddyfile" > "$tmp/Keep.fixture"

openssl req -new -x509 -nodes -newkey rsa:2048 -days 1 -subj /CN=Fixture \
  -addext 'subjectAltName=DNS:qs.girke.dev' \
  -keyout "$tmp/key.pem" -out "$tmp/ca.pem" 2>/dev/null

cat > "$tmp/Stub.Caddyfile" <<'CADDY'
{
  admin off
  auto_https off
}
:3000 {
  respond "app {method} {uri} {header.X-API-Key} {header.X-Twilio-Signature} {header.X-Hub-Signature-256} {host} {header.X-Forwarded-Proto} {header.Cookie} {header.Authorization} {header.X-Quantself-Owner-Proof} {header.Tailscale-User-Login}"
}
:3001 {
  respond "jobs|{method}|{uri}|{header.Authorization}|{header.X-Quantself-Owner-Proof}|{header.Tailscale-User-Login}|{header.Tailscale-User-Name}|{header.Tailscale-User-Profile-Pic}|{header.Tailscale-App-Capabilities}"
}

CADDY

container="$(docker run --pull never --detach --rm \
  -e QUANTSELF_TAILNET_IP=0.0.0.0 -e GATE_TAILNET_IP=0.0.0.0 -e HOSTINGER_TAILNET_IP=127.0.0.1 \
  --add-host qs.girke.dev:127.0.0.1 \
  -e QUANTSELF_OWNER_TAILNET_IPS=127.0.0.1 -e QUANTSELF_OWNER_INGRESS_TOKEN=fixture-proof \
  -e QUANTSELF_JOBS_RUNNER_TAILNET_IPS=127.0.0.1 \
  -p 127.0.0.1::8080 -p 127.0.0.1::8780 -p 127.0.0.1::8781 -p 127.0.0.1::8443 -p 127.0.0.1::443 \
  -v "$tmp:/fixture:ro" --entrypoint sh "$caddy_image" -c '
    GATE_TAILNET_IP=127.0.0.1 caddy run --adapter caddyfile --config /fixture/Hostinger.test &
    QUANTSELF_TAILNET_IP=127.0.0.1 caddy run --adapter caddyfile --config /fixture/Gate.Caddyfile &
    QUANTSELF_TAILNET_IP=127.0.0.1 QUANTSELF_FUNNEL_HOST=gate.example.ts.net caddy run --adapter caddyfile --config /fixture/Gate.Funnel.fixture &
    GATE_TAILNET_IP=127.0.0.1 caddy run --adapter caddyfile --config /fixture/Keep.fixture &
    exec caddy run --adapter caddyfile --config /fixture/Stub.Caddyfile
  ')"
edge_port="$(docker port "$container" 8080/tcp | cut -d: -f2)"
gate_port="$(docker port "$container" 8780/tcp | cut -d: -f2)"
funnel_port="$(docker port "$container" 8781/tcp | cut -d: -f2)"
origin_port="$(docker port "$container" 8443/tcp | cut -d: -f2)"
dashboard_port="$(docker port "$container" 443/tcp | cut -d: -f2)"

request() {
  local code
  code="$(curl --noproxy '*' --silent --show-error --max-time 3 --path-as-is \
    --cacert "$tmp/ca.pem" --output "$tmp/body" --write-out '%{http_code}' "$@")" || { printf 'Request failed for %s\n' "$*" >&2; return 1; }
  if [[ "$code" != "$expected" ]] || [[ "$code" == 200 && "$(<"$tmp/body")" != "$body" ]]; then
    printf 'Expected %s [%s], got %s [%s] for %s\n' "$expected" "$body" "$code" "$(<"$tmp/body")" "$*" >&2
    exit 1
  fi
}

for ((attempt = 1; attempt <= 12; attempt++)); do
  if curl --noproxy '*' --fail --silent --output /dev/null --max-time 1 \
    -H 'Host: hooks.girke.dev' "http://127.0.0.1:$edge_port/api/v1/todos"; then
    break
  fi
  if [[ "$attempt" == 12 ]]; then exit 1; fi
  sleep 1
done

request_hooks() {
  local method="$1" target="$2"
  local method_flags=(-X "$method")
  if [[ "$method" == HEAD ]]; then method_flags=(--head); fi
  request "${method_flags[@]}" -H 'Host: hooks.girke.dev' -H 'X-API-Key: fixture-key' \
    -H 'X-Twilio-Signature: fixture-signature' -H 'X-Hub-Signature-256: sha256=fixture' \
    -H 'X-Forwarded-Proto: http' -H 'Cookie: private-cookie' \
    -H 'Authorization: Bearer private' -H 'X-Quantself-Owner-Proof: forged' \
    -H 'Tailscale-User-Login: spoofed' "http://127.0.0.1:$edge_port$target"
}

id=9f11c1e9-80c6-4c2b-8dad-09db6382fe18
check_app() {
  expected=200 body="app $1 $2 fixture-key fixture-signature sha256=fixture hooks.girke.dev https    " request_hooks "$1" "$2"
}
check_app POST /api/v1/phone-jarvis/inbound
check_app POST "/api/v1/phone-jarvis/$id/answer"
check_app POST "/api/v1/phone-jarvis/$id/pin?attempt=0"
check_app POST "/api/v1/phone-jarvis/$id/status"
check_app POST /api/todo-webhooks/github
check_app GET '/api/v1/todos?includeCategories=true'
check_app GET /api/v1/todos/123
check_app POST "/api/v1/todo-jarvis/$id/commands"
check_app GET /api/v1/access-context
check_app GET /api/v1/todo-categories
check_app POST /api/v1/todo-categories
check_app GET /api/v1/habits/day
check_app GET /api/v1/habits/context
check_app GET /api/v1/habits/system
check_app POST /api/v1/habits/commands
check_app POST /api/v1/habits/slips
check_app POST /api/v1/habits/system/changes
# The legacy Hostinger edge stays available separately. Its compatibility
# collector path is identical, so the active Keep carries it to the native API.
check_app POST /api/v1/website-analytics/events
expected=200 body='app POST /api/v1/phone-jarvis/inbound?attempt=0 fixture-key fixture-signature  hooks.girke.dev https    ' \
  request -X POST -H 'Host: gate.example.ts.net' -H 'X-API-Key: fixture-key' \
  -H 'X-Twilio-Signature: fixture-signature' -H 'Cookie: fixture' \
  -H 'X-Quantself-Owner-Proof: forged' -H 'Tailscale-User-Login: spoofed' \
  "http://127.0.0.1:$funnel_port/api/v1/phone-jarvis/inbound?attempt=0"
expected=404 body='' request -X POST -H 'Host: hooks.girke.dev' \
  "http://127.0.0.1:$funnel_port/api/v1/phone-jarvis/inbound"
expected=404 body='' request -H 'Host: gate.example.ts.net' "http://127.0.0.1:$funnel_port/"

request_funnel() {
  local method="$1" target="$2"
  request -X "$method" -H 'Host: gate.example.ts.net' -H 'X-API-Key: fixture-portfolio-key' \
    -H 'Cookie: private-cookie' -H 'Authorization: Bearer private' \
    -H 'X-Quantself-Owner-Proof: forged' -H 'Tailscale-User-Login: spoofed' \
    "http://127.0.0.1:$funnel_port$target"
}
check_portfolio() {
  expected=200 body="app $1 $2 fixture-portfolio-key   hooks.girke.dev https    " request_funnel "$1" "$2"
}
check_portfolio POST /api/v1/website-analytics/events
check_portfolio POST /api/v1/website-analytics/inquiries
check_portfolio GET /api/v1/tracked-links/k3Vw9QpX2nR7tLzA
check_portfolio GET /api/v1/tracked-links/0123456789abcdef01234567
check_portfolio GET /api/v1/tracked-links/k3Vw9QpX
check_portfolio GET /api/v1/tracked-links/unknown
check_portfolio GET /api/v1/meetings/availability
check_portfolio GET '/api/v1/meetings/availability?from=2026-11-17T00:00:00Z&to=2026-11-24T00:00:00Z'
check_portfolio POST /api/v1/meetings
check_portfolio POST /api/v1/meetings/cancel

expected=404 body=''
request_funnel GET /api/v1/website-analytics/events
request_funnel GET /api/v1/website-analytics/inquiries
request_funnel POST /api/v1/website-analytics/inquiries/extra
request_funnel PATCH "/api/v1/website-analytics/inquiries/$id"
request_funnel GET /api/v1/website-analytics/report
request_funnel GET /api/v1/website-analytics/reports/website
request_funnel GET /api/v1/website-analytics/reports/job-search
request_funnel POST /api/v1/tracked-links/applications
request_funnel POST /api/v1/tracked-links/shares
request_funnel GET /api/v1/tracked-links/
request_funnel GET /api/v1/tracked-links/k3Vw9QpX2nR7tLzA/extra
request_funnel GET /api/v1/tracked-links/%6bnown
request_funnel GET /api/v1/tracked-links//a-post-launch
request_funnel GET /api/v1/tracked-links/other/../a-post-launch
request_funnel GET /api/v1/tracked-links/a-post-launch
request_funnel GET /api/v1/tracked-links/k3Vw9QpX2nR7tLzA%2Fextra
request_funnel GET /api/v1/tracked-links/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
request_funnel POST /api/v1/website-analytics/%65vents
request_funnel POST /api/v1/website-analytics/Events
request_funnel POST /api/v1/website-analytics//events
request_funnel POST /api/v1/website-analytics/x/../events
request_funnel POST /api/v1/website-analytics/events/
request_funnel GET /website-analytics/applications/registry
# Booking exposes exactly three method/path pairs.
request_funnel POST /api/v1/meetings/availability
request_funnel GET /api/v1/meetings
request_funnel GET /api/v1/meetings/cancel
request_funnel PATCH /api/v1/meetings
request_funnel DELETE "/api/v1/meetings/$id"
request_funnel GET "/api/v1/meetings/$id"
request_funnel POST "/api/v1/meetings/$id/cancel"
request_funnel GET /api/v1/meetings/settings
request_funnel PUT /api/v1/meetings/settings
request_funnel POST /api/v1/meetings/
request_funnel POST /api/v1/meetings/cancel/
request_funnel GET /api/v1/meetings/availability/
request_funnel POST /api/v1/Meetings
request_funnel POST /api/v1/%6deetings
request_funnel POST /api/v1/meetings%2Fcancel
request_funnel POST /api/v1//meetings/cancel
request_funnel GET /api/v1/meetings/x/../availability
request_funnel POST /website-analytics/applications/registry

# Keep must enforce the same negative boundary even after bypassing Gate.
for blocked_path in /website-analytics/applications/registry /api/v1/tracked-links/applications \
  /api/v1/website-analytics/events/ /api/v1/website-analytics/%65vents \
  /api/v1/meetings/availability /api/v1/meetings/settings /api/v1/meetings/cancel/; do
  [[ "$(docker exec "$container" curl --silent --show-error --path-as-is --max-time 3 \
    --output /dev/null --write-out '%{http_code}' -X POST -H 'Host: hooks.girke.dev' \
    "http://127.0.0.1:8443$blocked_path")" == 404 ]]
done

expected=404 body=''
request_hooks GET /
request_hooks GET /api/health
request_hooks GET /api/v1/todos/live
request_hooks PATCH /api/v1/todos/123
request_hooks POST /api/v1/todos
request_hooks POST /api/v1/todos/123
request_hooks POST /api/v1/todos/123/approval
request_hooks POST "/api/v1/todo-jarvis/$id/access"
request_hooks POST "/api/v1/todo-jarvis/$id/reconcile"
request_hooks POST "/api/v1/phone-jarvis/$id/delete"
request_hooks POST /api/v1/phone-jarvis/not-a-uuid/status
request_hooks POST /api/v1/phone-jarvis/inbound/
request_hooks POST /api/v1/Phone-Jarvis/inbound
request_hooks POST /api/v1/phone-jarvis/%69nbound
request_hooks POST /api/v1//phone-jarvis/inbound
request_hooks POST /api/v1/other/../phone-jarvis/inbound
request_hooks POST /api/v1/phone-jarvis%2finbound
request_hooks GET /api/v1/website-analytics/events
request_hooks HEAD /api/v1/website-analytics/events
request_hooks POST /api/v1/website-analytics/events/extra
request_hooks POST /api/internal/health
request_hooks GET /website-analytics/report
request_hooks POST /website-analytics/applications/registry/extra
request_hooks PUT /website-analytics/applications/registry
request -H 'Host: qs.girke.dev' "http://127.0.0.1:$edge_port/api/v1/todos"
for port in "$gate_port" "$origin_port"; do
  request -H 'Host: hooks.girke.dev' -H 'X-Forwarded-For: 127.0.0.1' \
    "http://127.0.0.1:$port/api/v1/todos"
done
request --resolve "qs.girke.dev:$dashboard_port:127.0.0.1" \
  -H 'Host: hooks.girke.dev' "https://qs.girke.dev:$dashboard_port/api/v1/todos"

request_dashboard() {
  request --resolve "qs.girke.dev:$dashboard_port:127.0.0.1" \
    -H 'Host: qs.girke.dev' -H 'X-Quantself-Owner-Proof: forged' \
    -H 'Tailscale-User-Login: spoofed' "$@" "https://qs.girke.dev:$dashboard_port$target"
}
# Call inside the fixture to exercise the approved connection source. A Docker
# published port originates at the Docker gateway and must never mint proof.
expected=200 body='app GET /todo    qs.girke.dev https    ' target=/todo \
  request_dashboard -H 'X-Forwarded-For: 127.0.0.1'
expected=200 body='app GET /todo agent-key   qs.girke.dev https    ' target=/todo \
  request_dashboard -H 'X-API-Key: agent-key'
inside="$(
  docker exec "$container" wget --no-check-certificate -qO- \
    --header 'Host: qs.girke.dev' --header 'X-Quantself-Owner-Proof: forged' \
    --header 'Tailscale-User-Login: spoofed' https://qs.girke.dev/todo
)"
[[ "$inside" == 'app GET /todo    qs.girke.dev https   fixture-proof ' ]]
inside="$(
  docker exec "$container" wget --no-check-certificate -qO- \
    --header 'Host: qs.girke.dev' --header 'X-Quantself-Owner-Proof: forged' \
    https://qs.girke.dev/api/health
)"
[[ "$inside" == 'app GET /api/health    qs.girke.dev https    ' ]]
inside="$(
  docker exec "$container" wget --no-check-certificate -qO- \
    --header 'Host: qs.girke.dev' --header 'X-API-Key: agent-key' \
    --header 'X-Quantself-Owner-Proof: forged' https://qs.girke.dev/todo
)"
[[ "$inside" == 'app GET /todo agent-key   qs.girke.dev https    ' ]]
jobs_path=/api/internal/jobs
jobs_claim="$jobs_path/work/claim"
jobs_pdf="$jobs_path/applications/$id/revisions/12/pdf"
jobs_request() {
  local expected="$1" method="$2" path="$3" actual_body actual_status result
  local authorization="${4-Bearer runner-fixture}"
  result="$(
    docker exec "$container" curl --silent --show-error --path-as-is --max-time 3 \
      --resolve qs.girke.dev:443:127.0.0.1 --cacert /fixture/ca.pem --write-out $'\n%{http_code}' \
      -X "$method" -H "Authorization: $authorization" \
      -H 'X-Quantself-Owner-Proof: spoofed' -H 'Tailscale-User-Login: spoofed' \
      -H 'Tailscale-User-Name: spoofed' -H 'Tailscale-User-Profile-Pic: spoofed' \
      -H 'Tailscale-App-Capabilities: spoofed' "https://qs.girke.dev$path"
  )"
  actual_body="${result%$'\n'*}"
  actual_status="${result##*$'\n'}"
  if [[ "$actual_status" != "$expected" ]] ||
    [[ "$expected" == 200 && "$actual_body" != "jobs|$method|$path|$authorization|||||" ]]; then
    printf 'Jobs fixture failed for %s %s: expected %s, got %s [%s]\n' \
      "$method" "$path" "$expected" "$actual_status" "$actual_body" >&2
    return 1
  fi
}
jobs_request 200 POST "$jobs_claim"
# The API enforces the bearer contract; the edge must not mint Owner proof without it.
jobs_request 200 POST "$jobs_claim" ""
jobs_request 200 POST "$jobs_path/work/$id/complete"
jobs_request 200 POST "$jobs_path/work/$id/fail"
jobs_request 200 POST "$jobs_path/work/$id/private-fields"
jobs_request 200 POST "$jobs_path/runner/heartbeat"
jobs_request 200 POST "$jobs_path/submissions/$id/events"
jobs_request 200 GET "$jobs_pdf"
jobs_request 200 PUT "$jobs_pdf"
jobs_request 404 GET "$jobs_claim"
jobs_request 404 POST "$jobs_pdf"
jobs_request 404 PUT "$jobs_path/applications/$id/revisions/-1/pdf"
jobs_request 404 POST "$jobs_path/work/not-a-uuid/complete"
jobs_request 404 POST "$jobs_path/work/$id/cancel"
jobs_request 404 POST "$jobs_path/work/%63laim"
jobs_request 404 POST "/api/%69nternal/jobs/work/claim"
jobs_request 404 POST "/api/Internal/jobs/work/claim"
jobs_request 404 POST "$jobs_path//work/claim"
jobs_request 404 POST "${jobs_claim}/"
jobs_request 404 POST /api/internal/inventory/unknown
expected=404 body='' target="$jobs_claim" request_dashboard \
  -X POST -H 'Authorization: Bearer runner-fixture' -H 'X-Forwarded-For: 127.0.0.1'
expected=404 body='' request_hooks POST "$jobs_claim"
expected=404 body='' request -X POST -H 'Host: gate.example.ts.net' \
  "http://127.0.0.1:$funnel_port$jobs_claim"
[[ "$(docker exec "$container" curl --silent --show-error --max-time 3 \
  --output /dev/null --write-out '%{http_code}' -X POST -H 'Host: hooks.girke.dev' \
  "http://127.0.0.1:8443$jobs_claim")" == 404 ]]

# An absent runner selector must keep the Jobs proxy unreachable.
docker exec "$container" env -u QUANTSELF_JOBS_RUNNER_TAILNET_IPS \
  caddy adapt --config /fixture/Keep.fixture --adapter caddyfile |
  grep -Fq '0.0.0.0/32'

printf 'Hostinger, Gate, Keep, private dashboard and Mac Jobs ingress checks passed.\n'
