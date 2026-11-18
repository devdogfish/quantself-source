# Honcho for Sam, Stacy and Tyler

[#357](https://github.com/devdogfish/quantself/issues/357) uses the private
Honcho instance from [ADR 0045](../../docs/adr/0045-self-hosted-home-infrastructure.md).
Keep VM 2551 is the approved target. The staged Debian 13 guest has 2 vCPUs,
2560 MiB RAM and a 16 GiB disk on the encrypted `local-lvm` pool. It was left
stopped with no NIC. The 2560 MiB allocation is a trial. Check memory, OOM
events and container restarts during the synthetic load and hosted worker
checks. [Placement and provisioning record](https://github.com/devdogfish/quantself/issues/357#issuecomment-6923962163)

## Prepare the guest

Use a dedicated amd64 Debian VM with encrypted storage and Docker Compose.
Give it an isolated bridge with outbound internet for image pulls and model
calls. Deny traffic to the LAN and other VM networks.
Follow [#217](https://github.com/devdogfish/quantself/issues/217) for the guest
and network changes. The [Compose file](compose.yaml) pins Honcho v3.6.1,
PostgreSQL 15 with pgvector and Redis 8.2 to their upstream amd64 digests.
The API and deriver use separate containers. PostgreSQL and Redis are on an
internal Docker network. The API binds only to `127.0.0.1:18081` on the guest.
The API and deriver need outbound HTTPS to the hosted model provider.

Use a dedicated data directory on the encrypted disk. Compose mounts it
directly as PostgreSQL's data directory, where the image initializes files
and sets their ownership. Use an empty directory for a fresh deployment or
the logical restore below.

The Owner creates the following private files inside `/etc/honcho` on the
guest. Use a mode `0700` directory and root-owned mode `0600` files.

| File | Contents |
| --- | --- |
| `postgres-password` | A generated URL-safe password on one line |
| `runtime.env` | `DB_CONNECTION_URI=postgresql+psycopg://honcho:<password>@database:5432/honcho` and `LLM_OPENAI_API_KEY=<hosted model key>` |
| `api-auth.env` | `AUTH_JWT_SECRET=<generated signing secret>` |

Replace the placeholders in the private files. No secret belongs in the repo
or the fleet JSON. Use the upstream v3.6.1 OpenAI model and embedding defaults
for the first validation. Run `sudo python3 -I stage-tokenizers.py` before
starting Compose. It verifies the two encoding files against the hashes from
the pinned tiktoken dependency. The API and deriver mount the cache read-only,
which lets the API start during a disconnected restore. The image runs database
migrations before serving the API. Run `docker compose up -d --wait` from this
directory during the approved guest setup. Verify health with
`http://127.0.0.1:18081/health`.
[Upstream self-hosting guide](https://github.com/plastic-labs/honcho/blob/v3.6.1/docs/v3/contributing/self-hosting.mdx)

Apply the approved deployment-specific policy fragment after
checking for existing broader grants, then enroll the guest as `tag:honcho`.
Run `sudo tailscale serve --bg http://127.0.0.1:18081` to proxy HTTPS on
TCP 443 to the loopback API. Keep Tailscale SSH, Funnel and route advertisement
disabled. Check
that Agent machines reach 443, the API rejects a request without a token,
and unrelated peers and the LAN cannot reach the service. Manage the guest
through the trusted Proxmox console or guest agent.

## Workspace and acceptance

In the Owner's private guest console, issue a workspace-scoped token with the
upstream script. Set `HONCHO_WORKSPACE` to `honcho_workspace` in the one fleet
file and choose the token lifetime in `TOKEN_LIFETIME`. Redirect the output
to a private file for the Owner's Vaultwarden handoff.

```sh
umask 077
docker compose exec -T api /app/.venv/bin/python scripts/generate_jwt.py \
  --workspace "$HONCHO_WORKSPACE" --expires "$TOKEN_LIFETIME" --print-only \
  > "$PRIVATE_TOKEN_FILE"
```

The Owner enters the workspace token as `HONCHO_API_KEY` in the Agent's
private Vaultwarden startup folder. Set `honcho_url` to the guest's Tailscale
HTTPS hostname. The pinned Hermes plugin substitutes a placeholder for the
environment token with literal private addresses. The three Agent configurations
use the same `honcho_workspace` and `honcho_owner_peer`. Their AI peers are `sam`,
`stacy` and `tyler`. Workspace-scoped tokens can access the collaboration
workspace, including its shared Owner peer. Keep private data and credentials
outside the workspace. [Plugin token selection](https://github.com/plastic-labs/honcho/blob/894b88321872e01702a1aa638ddfdde6ad60f173/hermes-plugin-honcho/client.py#L741-L751) · [Upstream token generator](https://github.com/plastic-labs/honcho/blob/v3.6.1/scripts/generate_jwt.py)

Before starting the first Hermes gateway, run the synthetic API round trip.
The `write` step creates the workspace and the Owner and Agent peers. Use a
unique probe ID and retain it in the recovery evidence. Use `--loopback` only when
running on the Honcho guest to reach its local port. Both modes verify
authentication and workspace scope. Repeat `read` against the same ID after
each restore. A `write` rerun checks existing messages before sending any
missing batch. Reconcile an ambiguous request with `read` first.

```sh
python3 -I verify-workspace.py write "$FLEET_JSON" "$PRIVATE_TOKEN_FILE" "$PROBE_ID" --loopback
python3 -I verify-workspace.py read "$FLEET_JSON" "$PRIVATE_TOKEN_FILE" "$PROBE_ID" --loopback
```

Verify the deriver processes a planned synthetic session through the hosted
provider. Check the queue and the resulting representation for the synthetic
input. During each Agent's bring-up, verify the installed Hermes memory
provider writes a synthetic conversation using that Agent's vault token, the
shared Owner peer and its own AI peer and session prefix. Read it back with
`honcho_context`. Include the first turn of a fresh session in the check and
record any missing turns, since Honcho initializes in the background.

## Backup and recovery

Include the guest in nightly encrypted PBS, with an independent restore to a
guest without a NIC or autostart. For B2 on Keep, use a dedicated prefix-scoped
key and independent repository password as in the
[Keep offsite policy](../../docs/infra/keep-storage/offsite.md). PostgreSQL
holds the durable workspace and queue data. Capture a consistent database dump
into private staging on encrypted storage before uploading with restic.

```sh
umask 077
docker compose exec -T database pg_dump -U honcho -d honcho --format=custom \
  > "$PRIVATE_STAGING/honcho.dump"
docker compose exec -T database pg_restore --list \
  < "$PRIVATE_STAGING/honcho.dump" > /dev/null
python3 -I stage-tokenizers.py --verify-only
install -d -m 0755 "$PRIVATE_STAGING/tokenizers"
cp -a /var/lib/honcho/tokenizers/. "$PRIVATE_STAGING/tokenizers/"
```

Capture the `restic backup --json` snapshot ID and restore that exact snapshot
with the recovery credentials and `restic restore --verify`. In the isolated
guest, start `database` and `cache` against a fresh data directory. Stream the
dump into `pg_restore -U honcho -d honcho --no-owner --exit-on-error
--single-transaction` inside the database container. Verify the restored
tokenizers with `python3 -I stage-tokenizers.py --verify-only "$RESTORED_TOKENIZERS"`
and point `HONCHO_TOKENIZER_DIR` at that directory. Start the API alone with
`docker compose up -d --wait api`. Run the synthetic `read` probe on
loopback with the same workspace and probe ID. Record the PBS and B2 snapshot
IDs and the application reads before handling live conversation data.
