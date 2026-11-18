# Quantself ingress

Follow the [girke.dev DNS runbook](../../docs/infra/girke-dev-dns.md) before
changing DNS or certificate scope. Spaceship serves the authoritative zone.
Add `qs.girke.dev` as a DNS-only A record pointing to the Quantself VM's tailnet IPv4 address.
Keep Caddy serves that hostname on tailnet TCP 443 with a publicly trusted
certificate issued through the Spaceship DNS challenge.

The Hostinger-independent candidate takes public HTTPS through Tailscale
Funnel to Gate. Gate applies the route allowlist and forwards permitted requests
over the tailnet to Keep's dedicated webhook listener, which accepts only Gate.
Keep routes verified callbacks and native portfolio requests to the API through
the app gateway on loopback TCP 3000. Hostinger retains the standalone
collector and legacy registry for rollback.

## Hostinger route inventory

The running Hostinger edge config and the app gateway were checked read-only.
`api.girke.dev` serves the separate Girke API and the board aliases
`/youtube-strategy-files/*`, `/files/*`, `/boards/*`. The dashboard virtual
host forwards the exact analytics collection path to its standalone relay.
Its other routes pass to Quantself's gateway. That gateway rejects
`/api/internal` and its subtree, sends `/api`, `/api/*` and `/llms.txt`
to the API and sends the rest to the web app. A public anonymous request to
the live collector and a public anonymous registry lookup both returned 401.
The portfolio documentation confirms it uses the collector and the scoped
registry. [Analytics](../../docs/website-analytics.md)

| Caller | Exposed routes and evidence |
| --- | --- |
| Twilio | POST `/api/v1/phone-jarvis/inbound` and `/api/v1/phone-jarvis/{id}/{answer,pin,status}` for server-generated UUIDs. [Signed handler](../../apps/api/src/phone-jarvis-route.ts) |
| ElevenLabs | GET `/api/v1/todos`, `/api/v1/todos/{number}`, `/api/v1/access-context`. POST `/api/v1/todo-jarvis/{id}/commands` for a capture UUID. GET and POST `/api/v1/todo-categories` for phone tools. GET `/api/v1/habits/day`, `/api/v1/habits/context`, `/api/v1/habits/system` and POST `/api/v1/habits/commands`, `/api/v1/habits/slips`, `/api/v1/habits/system/changes` for scoped habit tools. [Web tool validator](../../apps/api/src/todos-jarvis.ts), [phone category tools](../../apps/api/src/phone-jarvis-task-tools.ts), [habit tool definitions](../../apps/api/src/jarvis-habits.ts) |
| GitHub App | POST `/api/todo-webhooks/github`. The production API has the webhook signing secret configured. Confirm the active GitHub App URL and delivery during cutover. [Signed handler](../../apps/api/src/todos-freshness-route.ts) |
| Portfolio | POST `/api/v1/website-analytics/events` and `/api/v1/website-analytics/inquiries` use the dedicated ingest `X-API-Key`. GET `/api/v1/tracked-links/{code}` uses the separate lookup `X-API-Key`. GET `/api/v1/meetings/availability` and POST `/api/v1/meetings` and `/api/v1/meetings/cancel` use a booking-only API key with the single `meetings:book` permission. [Ingest #303](https://github.com/devdogfish/quantself/pull/303), [tracked links #304](https://github.com/devdogfish/quantself/pull/304), [booking #371](https://github.com/devdogfish/quantself/issues/371) |

Only these methods and escaped paths match
[webhooks.caddy](webhooks.caddy). The public proxies
discard Cookie and Authorization and preserve the URI query, body, signature
and API-key headers. This includes Twilio's signed `?attempt=N` query and
the portfolio's server-side ingest and lookup keys. The Funnel and Keep reject
the legacy registry, reports, inquiry status changes and tracked-link registration.

## Hostinger-independent rehearsal

Gate can receive public HTTPS via Tailscale Funnel and forward only the
allowlisted paths over the existing Gate-to-Keep grant. The candidate endpoint
is the HTTPS origin for the Funnel hostname configured on Gate.
`qs.girke.dev` stays private, with Spaceship authoritative.

The first rehearsal found that Hostinger's existing `hermes-agent` node
requires login. Gate TCP 8780 and its dedicated firewall and grant were
removed from operation. The Gate-only Funnel rehearsal on November 14
returned trusted TLS, 200 for the exact synthetic POST, and 404 for the
root and escaped alternate path through both public IPv4 relay addresses.
The synthetic listener and Funnel were then stopped. The Gate-only policy
attribute remains available for the next approved rehearsal.

Stage [Gate.Funnel.Caddyfile](Gate.Funnel.Caddyfile) on loopback TCP 8790
for the real delivery test. Install [quantself-hooks-funnel.service](quantself-hooks-funnel.service).
Set `QUANTSELF_FUNNEL_HOST` to Gate’s verified Funnel hostname and
`QUANTSELF_TAILNET_IP` to the verified node address in `/etc/quantself-hooks/funnel.env`. Enable the Funnel only with
approval using `tailscale funnel --bg --https=443 http://127.0.0.1:8790`.
Reversal uses `tailscale funnel --https=443 off` and stops the listener.
Keep the production provider URLs active until the rehearsal succeeds.
At cutover set both `QUANTSELF_PHONE_PUBLIC_URL` and
`QUANTSELF_JARVIS_TOOL_ORIGIN` on Keep to
the HTTPS origin for that hostname. Update the Twilio Voice inbound URL, the
existing ElevenLabs web and phone tools, the GitHub App webhook, and the
portfolio ingest and tracked-link lookup destinations once the matching native
API and portfolio releases are ready. Verify a 202 ingest, event and inquiry
replays, a successful lookup, and an unknown code. Preserve the ElevenLabs secret references
when updating tool URLs. Verify live deliveries and retain the previous URLs
for rollback. Gate uses `hooks.girke.dev` as an internal Host header to Keep.

### Check the staged Atlas origin

From the reviewed checkout, check the exact staged Caddyfile and its
imports. Take observed settings from the staged unit environment file.
Separately, keep the approved settings from the cutover record in a
JSON file owned by the operator, mode `0600`. Both relay files require
`QUANTSELF_TAILNET_IP` (approved Atlas) and `FENCED_KEEP_TAILNET_IP`.
The Funnel file also requires `QUANTSELF_FUNNEL_HOST`. The legacy file
requires `GATE_TAILNET_IP` and `HOSTINGER_TAILNET_IP`. Use the same Caddy
binary as the service.

```sh
QUANTSELF_TAILNET_IP="$staged_funnel_origin" QUANTSELF_FUNNEL_HOST="$staged_funnel_host" \
  python3 -B deploy/gateway/verify_gate_route.py funnel "$staged_funnel_caddyfile" \
    "$approved_funnel_json"
```

If the legacy relay is in the approved scope, check its separate files
and settings as well. Leave an unused legacy relay disabled.

```sh
QUANTSELF_TAILNET_IP="$staged_relay_origin" GATE_TAILNET_IP="$staged_gate_ip" \
  HOSTINGER_TAILNET_IP="$staged_hostinger_ip" \
  python3 -B deploy/gateway/verify_gate_route.py legacy "$staged_relay_caddyfile" \
    "$approved_relay_json"
```

Require exit 0 and `{"verified_relays": 1}` for each enabled relay. The check compares
the full adapted route tree, including host and source matchers, header
handling, and method/path denies. It checks staged configuration.
In the scoped window, match the Gate service startup record to the checked
files and route settings, confirm `tailscale funnel status --json` maps
the public host to loopback 8790, and verify the approved live delivery
and direct-path denials before Atlas opens writes.
[Caddy adaptation](https://caddyserver.com/docs/command-line#caddy-adapt)

### Native portfolio credentials

Provision four distinct tokens into Keep's API runtime. Put the four Keep
variable names and values in a private, owned mode-0600 JSON file. From the
reviewed checkout on Keep, run
`python3 scripts/provision-runtime-env.py .env --native-analytics-runtime-file "$native_runtime_file"`.
Use the approved production dotenv path. This atomically replaces the four keys
without restarting services.

| Keep API variable | Matching caller setting |
| --- | --- |
| `QUANTSELF_WEBSITE_ANALYTICS_INGEST_TOKEN` | Portfolio server `QUANTSELF_ANALYTICS_INGEST_TOKEN` for both POSTs |
| `QUANTSELF_TRACKED_LINKS_READ_TOKEN` | Portfolio server `QUANTSELF_TRACKED_LINKS_READ_TOKEN` for lookup |
| `QUANTSELF_TRACKED_LINKS_APPLICATION_TOKEN` | Mac runner's private `applicationTracking.token` for application registration |
| `QUANTSELF_TRACKED_LINKS_SHARE_TOKEN` | Owner CLI `QUANTSELF_TRACKED_LINKS_SHARE_TOKEN` for share registration |

Set Portfolio `QUANTSELF_ANALYTICS_ORIGIN` to Gate’s Funnel HTTPS origin and
`QUANTSELF_TRACKED_LINKS_URL` to that origin’s `/api/v1/tracked-links` endpoint.
Set the Mac runner's private `applicationTracking.registryUrl` to
`https://qs.girke.dev/api/v1/tracked-links/applications`. The Owner CLI uses
`QUANTSELF_API_URL=https://qs.girke.dev`. Keep both registration credentials on
the private network.

## Cutover inputs

- Build Caddy 2.11.4 with the Spaceship module using
  `xcaddy build v2.11.4 --with github.com/empressmarissa/caddy-dns-spaceship@f44db5deb4be90b9fec034c93856048cc9179690`.
  This pins the v1.2.0 fix for generic TXT records and zone-relative names.
  On Keep, use a root-owned environment file to supply
  `LIBDNS_SPACESHIP_APIKEY` and `LIBDNS_SPACESHIP_APISECRET` to Caddy.
  The Owner creates credentials with the minimum DNS permissions available
  and retains access to Caddy's certificate storage for renewal. Verify
  issuance and renewal against the authoritative Spaceship zone. [Spaceship DNS module](https://github.com/empressmarissa/caddy-dns-spaceship/tree/f44db5deb4be90b9fec034c93856048cc9179690)
- Stage [Hostinger.Caddyfile](Hostinger.Caddyfile) beside the live Caddy config
  and include its contents in the file already mounted in the edge container.
  Expand `GATE_TAILNET_IP` to the reviewed peer address when staging the config, or supply it in the edge container. Verify that its existing Docker
  network reaches Gate over Tailscale before changing Spaceship's hooks A
  record. Reuse the host's existing public HTTP(S) listener for ACME and the
  hook hostname. Preserve its API, boards, and rollback dashboard sites.
- Use [Gate.Caddyfile](Gate.Caddyfile) on Gate and
  [Keep.Caddyfile](Keep.Caddyfile) on the Quantself VM. Supply the exact
  `HOSTINGER_TAILNET_IP`, `GATE_TAILNET_IP`, and `QUANTSELF_TAILNET_IP`
  where referenced. With named approval, grant Hostinger's verified peer only
  Gate TCP 8780 and limit that host firewall listener to the same Tailscale
  peer. Reuse the Gate-to-Quantself TCP 8443 grant and pair it with Keep's
  source check. Verify the Caddy logs see each real source IP and direct
  LAN, unexpected tailnet peers and spoofed forwarded IPs fail.
- Hand off Keep's existing HTTPS 443 listener to Caddy under the approved
  cutover. Install [quantself-ingress.service](quantself-ingress.service) with
  the reviewed binary and the three Caddy configuration files in
  `/etc/quantself-ingress`. Reuse the certificate storage from the loopback
  rehearsal. Set `QUANTSELF_OWNER_TAILNET_IPS` to the exact approved Mac and
  iPhone Tailscale IPs. On Keep, `tailscale whois --json <IP>` must identify
  the intended Owner's untagged device. The read-only preflight matched
  the approved Mac and iPhone. Match their node IDs again
  at cutover or after re-enrolment. Keep peer admission on `tailscale0`. Caddy
  checks the connection's peer IP and overwrites presented identity headers.
  Supply the same private `QUANTSELF_OWNER_INGRESS_TOKEN` (64 lowercase hex
  characters from 32 random bytes) to Keep Caddy and the app/API via separate
  root-owned env files. Keep it out of logs and Git. Agent requests with
  explicit credentials and /api/health continue without Owner proof.
### Initial Hostinger relay policy and reversal

Hostinger's Caddy runs on the `girke-edge` Docker bridge. Verify its
destination route and source NAT using a disposable test endpoint. Gate
must see the actual Hostinger Tailscale IP from the private relay configuration.
Fill in the verified relay addresses, preview the policy tests and add the
grant to the live policy after approval:

```json
{"src":["<Hostinger Tailscale IP>"],"dst":["<Gate Tailscale IP>"],"ip":["tcp:8780"]}
```

Stage [gate-firewall.nft](gate-firewall.nft) with the
[private renderer](../../scripts/infra/keep-storage/prepare-compose-bundles.py).
Use `--repo-root . --firewall-role gateway` with an owner-only input JSON
containing `GATE_PEER_IPV4` and a private staging directory. Keep the current
installed file for rollback. On Gate put `Gate.Caddyfile`, its two imports,
and the rendered `gate-firewall.nft` in `/etc/quantself-hooks/`. Store
the three verified peer IPs in `relay.env`. Install the two
`quantself-hooks*.service` units on Gate alongside the verified Caddy
binary at `/usr/local/bin/caddy`. After `nft -c -f` and
`systemd-analyze verify` pass, start `quantself-hooks.service`. Systemd
loads the dedicated firewall table before starting Caddy. Check its pinned
source against the grant before loading.
Keep TCP 8443 restricted to Gate. Test both hops, including denied traffic
from other peers, direct LAN, and Hostinger attempts to reach private HTTPS
or SSH. Remove the dedicated table and grant together when rolling back.

Stage the Hostinger import, Gate service and Keep listener with the existing
sender URLs active. Validate the merged Caddy config before loading it.
Take a copy of the prior edge config, scope changes to the two new site
records, and record public DNS TTLs. Verify the candidate with an anonymous
401 from the collector and a 404 for excluded paths, then use an approved
authenticated delivery at the final hostname. To reverse, restore provider
URLs and DNS records first, then remove the new relay entries and revert
only the named rule changes.

The final Keep listener uses the native API. Restore the original standalone
Hostinger bindings and previous portfolio deployment for legacy analytics
rollback. The retained Hostinger relay files document the earlier transport.

## Offline proof

Run `deploy/gateway/verify.sh` with Docker, `caddy:2.11.4-alpine`, curl and
OpenSSL. It checks the three proxy hops, escaped path and method denials,
direct listener and Host spoofing, signed query preservation and routing to
the right backend. It also checks proof injection for the approved peer, proof stripping for an Agent or webhook, and health without proof. It uses a test certificate for Keep. Live certificates,
tailnet grants, Owner identity and vendor deliveries are cutover checks.
