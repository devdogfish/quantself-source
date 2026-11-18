# Private application deployment

Status: app/API/gateway/PostgreSQL are running at `/opt/keep-quantself` on
`quantself`; Owner passkey enrollment and private HTTPS work. This is a fresh
synthetic environment for #254. Live storage flows and scoped Vault permissions
passed. The first coordinated encrypted PBS and B2 backup pair is complete.
Manual isolated PBS and B2 application recovery passed. The no-NIC
PostgreSQL rehearsal and VM 2544 cleanup passed. Both timers are enabled. The
requested immediate backup passed. PostgreSQL restore also verified that pair, removed VM 2544 and its volumes,
and reported success to Healthchecks.
The isolated application lab was removed after validation. Owner recovery
copies and backups were retained. [Nightly and cleanup evidence](nightly-proof.json). [Pair evidence](first-pair-proof.json). [Restore runbook](restore-runbook.md).

## Start #209 here

Before deployment or cutover preparation, follow the [infrastructure session workflow](../../agents/infrastructure-sessions.md), including its #209 phases. It records #254's execution lessons: pretested helpers, resumable operations, scoped temporary credentials, prepared approvals and reuse of valid evidence. Combine this handoff with #209's current acceptance criteria; the production migration and rollback checks remain required.

## Bundle

- [Prepare both bundles offline](#prepare-both-bundles-offline) to render
  the private endpoints, stage the Caddyfiles, and produce the installed
  `compose.yaml` filenames. The App bundle includes `env.example`.
- Use the staged bundles for new installs or replacements. The tracked Compose
  templates require explicit private endpoints and fail validation without them.
- Application image was built for Linux AMD64 from commit
  `1e64dfda64c855ef9801b44d1ec912faf69d15b6`, including #253 and cancelled-media drain fixes.
  Its deployed immutable ID is
  `sha256:60abe78f12a689a755699a4719fe6691ad68fb9d4cccff3854d6b130bf1e079d`.
  See [image-proof.json](image-proof.json); never select by mutable tag alone.
- The replacement passed isolated Next/Caddy/API shutdown tests and was deployed
  on 2026-11-14 by 06:56 UTC. Both services became healthy; private HTTPS returned
  200 with trusted TLS. Synthetic PDF, PNG and WAV hashes and a 65,536-byte WAV
  range matched. Verified `image.tar.gz`, `image.json` and `SHA256SUMS` are staged
  at `/opt/keep-quantself/app-image`. The backup must carry the three files under
  `tree/deployment/app-image` because CI retains the private artifact for one day.
  The first encrypted PBS and B2 pair includes that verified archive. Both
  isolated application restores passed. The Owner received the separate synthetic
  PostgreSQL restore failure alert. [Alert evidence](alert-test-proof.json). [Pair evidence](first-pair-proof.json).
- PostgreSQL and Caddy image index digests are pinned in the bundle. Both were
  pulled on the VM. PostgreSQL uses the AMD64 18.7-alpine3.24 manifest.

The application and API consume the same schema/auth contract as root Compose.
This fresh environment explicitly selects OpenCloud and has no legacy original-file
volumes. Three volumes persist PostgreSQL, the shared auth secret, and capture JSON.
Capture audio lives in OpenCloud; capture JSON must still be included in recovery.
No production integration credentials or source records are included.

The gateway publishes only `127.0.0.1:3000`; PostgreSQL/API/app have no host ports.
Trusted HTTPS is configured through tailnet-only Tailscale Serve on this VM.
Do not expose the gateway on the LAN or enable Funnel.
OpenCloud credentials appear only in the API environment. The database credential
is needed by migrations, API and app. Runtime memory limits total 3,200 MiB for the
four long-lived services; actual peak use remains to be measured on the 4 GiB VM.

## Prepare both bundles offline

From the repository root, run the preparer with the owner's private endpoint
JSON file and an existing private staging directory. The CLI help describes the
three input keys. Use the existing origins and RP ID when preparing a replacement.

```sh
python3 scripts/infra/keep-storage/prepare-compose-bundles.py --repo-root . \
  --input "$endpoint_file" --staging-parent "$staging_parent"
```

The printed directory contains `app/compose.yaml`, `app/Caddyfile`,
`app/env.example`, `vault/compose.yaml` and `vault/vault.Caddyfile`, using the
installed filenames. Each run creates a separate directory. Use
`--templates-dir scripts/infra/keep-storage` for Compose-only staging.
Existing prepared bundles remain usable with the normal operator commands.
The input JSON stays outside the bundle. Image preparation, the app's private
`.env`, installation and startup remain separate operator steps.

## Owner secret setup and startup — completed

The reviewed helper `scripts/infra/keep-storage/owner-app-secrets.sh` has two stages:
Owner email/recovery directory, then scoped token/database setup and service startup.
It requires an already-loaded immutable image recorded in `/opt/keep-quantself/image-id`.
It creates a 90-day token for `quantself`, stores a private Mac recovery JSON,
installs root-only `.env` and nonsecret token-expiry metadata, validates Compose,
and starts the synthetic app. It preserves existing credentials and refuses a
conflicting configuration. **Only the Owner runs it; the Owner completed it.**

Follow #217: the Owner performs secret entry/generation in their own terminal.
Never display `docker compose config`, container environments or the populated
`.env` to the agent; `config --quiet` validates without exposing values.

Prerequisites:

1. Vault initialized through the previously supplied Owner helper.
2. Dedicated originals space; non-admin app Editor; everyday Owner Viewer;
   separate Owner-managed personal-document space; access denials verified.
3. App token with expiry, rotation and revocation tested. Account-password Basic
   authentication stays disabled.
4. Built image loaded and its content ID checked against the private CI artifact manifest.
5. Owner creates `/opt/keep-quantself/.env`, root-owned mode 0600, using the template.
   Database password and URL must match; URL-encode password characters. Use only
   credentials for this synthetic private environment.

After these prerequisites, the Owner can initialize the auth secret and start
the services from their own terminal:

```sh
sudo docker compose --project-directory /opt/keep-quantself \
  --env-file /opt/keep-quantself/.env -f /opt/keep-quantself/compose.yaml config --quiet
sudo docker compose --project-directory /opt/keep-quantself \
  --env-file /opt/keep-quantself/.env -f /opt/keep-quantself/compose.yaml up -d --wait
```

Migrations completed before app/API startup. Owner enrollment/passkey setup and
trusted private HTTPS were observed. PDF receipt upload/download and original
image rendering passed with synthetic data; see [receipt evidence](live-receipt-proof.json).
Synthetic recording upload and authenticated Inventory playback and seeking
passed. The To-Do capture audio passed full and ranged API reads. Vault Editor
CRUD, Owner Viewer restrictions and personal-space denials passed.
[Audio evidence](live-audio-proof.json), [Vault permission evidence](vault-permissions-proof.json).

## Backup shutdown contract

SIGTERM/SIGINT stops accepting new requests, closes live task streams, waits for
active request handlers and worker jobs, drains cache work, then disconnects the
database. Disconnected clients do not hide pending request work. The API exits 0
only after completion; its 13-minute deadline exits 1. Compose allows 15 minutes.
Backup orchestration must inspect container exit state and reject forced/error
shutdowns; an accepted `docker stop` command alone is insufficient evidence.

The web app uses Next's graceful SIGTERM handler and also gets 15 minutes. Next
16.2.9 exits 143 after graceful cleanup; its exit code alone cannot prove cleanup
because unhandled SIGTERM uses the same code. Deployed request-drain verification
is still required. Stop public ingress first, initiate API shutdown to close SSE,
and drain both app/API before stopping Vault or dumping PostgreSQL.

The candidate image passed isolated container-signal tests with deferred HTML,
active and abandoned SSE, a partial WAV TCP reset and an admitted database write.
CI passed typecheck and 1,748 tests (13 existing skips). Both guests completed
clean pause and resume during the first coordinated backup. Manual isolated
PBS and B2 application recovery passed. [Pair evidence](first-pair-proof.json).
The backup must include capture JSON, DB dump/schema, OpenCloud configuration,
system state/xattrs and originals in one complete restore point, as required by
`docs/opencloud-originals.md`.

The verified image is recorded in root-owned `/opt/keep-quantself/image-id`.
Artifact and runtime-test evidence: [image-proof.json](image-proof.json).

The first Owner app-helper attempt rejected OpenCloud 7.2.5's default six-word
diceware token because the parser incorrectly required a compact token. The
helper now preserves spaces and saves a private pending response before parsing,
so subsequent retries reuse the credential. Four synthetic regression checks
passed, including an interrupted recovery-bundle write. The Owner subsequently
rotated the deployed API token, revoked both prior tokens, and verified old-token
401, replacement access and API health. One token remains.
[Vault rotation evidence](vault-permissions-proof.json).

Owner completed the corrected credential helper and `owner-open-app.py`. All
long-lived services are healthy; Owner passkey setup succeeded and the signed-in
dashboard was observed. The named-approved private Tailscale HTTPS endpoint is
active with trusted TLS. Restored Vault permission and rotation checks passed
for both PBS and B2.

`scripts/infra/keep-storage/validate-receipt.ts` runs inside the existing API
container and uses its deployed adapter, without creating or printing credentials.
It accepts only the SHA-256-pinned synthetic PNG at
`/tmp/keep-storage-254-synthetic-receipt.png`, checks the private Keep environment,
and derives the test Owner from the browser-created PDF receipt. It leaves a fixed
synthetic receipt ID for restore comparison; repeated runs reuse matching content
and report that reuse rather than claiming another initial upload. It records only
synthetic IDs/hashes, aggregate timings and HTTP method counts. This direct adapter
check supplements the real browser upload; it does not test HTTP upload authorization.


### Stage the guest firewall

Run [the offline renderer](../../../scripts/infra/keep-storage/prepare-compose-bundles.py)
with `--repo-root . --firewall-role guest --input <private JSON> --staging-parent <private directory>`.
The owner-only JSON contains the verified `KEEP_GUEST_DNS_IPV4` value. Use the
staged `guest/guest-firewall.nft` for the existing install procedure. Preserve
the installed file for rollback and validate the staged rules with `nft -c`
before activation.


### Optional Owner probes

Supply the verified origins from the owner-only endpoint configuration.
The setup-link helper requires `KEEP_BETTER_AUTH_URL`. The audio, receipt,
and Vault access probes require both `KEEP_BETTER_AUTH_URL` and
`KEEP_OPENCLOUD_URL`. For a probe invoked through container stdin, pass those
variables explicitly to the existing container execution command. Use the
same values approved for the role render so the probes can check the running
configuration and scope their HTTPS requests.

The optional network probe requires `KEEP_NETWORK_PROBE_TARGETS` to point to an
owner-only JSON file with mode `0600`. Supply bare addresses from the approved
private network plan, keyed by probe target. All keys below are required.

- Supply six distinct IPv4 peer addresses for `files`, `app`,
  `httpsAndSsh`, `httpsOnly`, `proxmox`, and `pbs`.
- `files` and `app` identify the Files and App targets.
- `httpsAndSsh` identifies the additional target tested for denied HTTPS and SSH.
- `httpsOnly` identifies the additional target tested for denied HTTPS only.
- `proxmox` identifies the Proxmox management target tested for denied connections
  to its API and SSH ports.
- `pbs` identifies the Proxmox Backup Server target tested for denied connections
  to its API and SSH ports.
- Supply distinct IPv4 addresses for `managementSsh` and `managementBackup`,
  the management targets checked for denied SSH and backup access.
- `filesTailnetV6` is the Files Tailnet IPv6 address.
- Supply four distinct link-local IPv6 addresses for `linkLocalHttps`,
  `linkLocalSsh`, `linkLocalManagementSsh`, and `linkLocalManagementBackup`.
  Leave off IPv6 zone IDs. The probe scopes link-local addresses to the default
  route's interface.

### Private trust inputs still required

Set `KEEP_SSH_KNOWN_HOSTS` to an owner-only file containing the three
approved Ed25519 host-key records for the existing SSH identities. Copy the
records exactly from the approved private baseline, keep the file outside the
checkout, and set mode `0600`. All four owner tools use this input. They stage
the records as `known_hosts` in a private directory for each SSH invocation.
Host-key checks use that file and require an exact match.

Set `KEEP_VAULT_SSH_HOST` and `KEEP_GUEST_SSH_HOST` for
`owner-secrets.sh`, and `KEEP_PBS_SSH_HOST` for
`owner-pbs-restore-alias.sh`. Use the existing approved Tailnet hostname for
each role, as recorded in the three matching host pins. Supply hostnames
without usernames or ports. Use the existing approved IPv4 resolver as
`KEEP_GUEST_DNS_IPV4` when running `provision-guests.sh`. Supply the approved
guest MACs as `KEEP_FILES_MAC` and `KEEP_QUANTSELF_MAC`.

Preserve the
strict verification settings. Moving the Tailnet policy and policy fragment
requires the current private source identities and rule-test targets. Retain
the same grants, deny expectations, and manual policy-validation procedure.

### Stage the Vault backup identity

Use the same owner-only endpoint JSON used for the approved Compose bundles.
Verify that its `KEEP_OPENCLOUD_URL` matches the approved Files Serve hostname
and OIDC issuer. Use the bare HTTPS Tailnet origin without a port or slash.

```sh
python3 scripts/infra/keep-storage/prepare-compose-bundles.py \
  --repo-root . --vault-backup-identity \
  --input "$private_endpoints" --staging-parent "$private_staging_parent"
```

The returned directory contains `backup/vault-identity.json` with mode 0600.
For the reviewed rollout, install it on the Files guest as
`/etc/keep-backup/vault-identity.json`, root:root mode 0600, before installing
the updated backup script. Keep the existing gateway proof and its config
digest. Backup admission checks the exact Serve route against this sidecar,
and resume checks the issuer against the same origin.

### Tailnet policy preflight

Keep the template, role inputs, and independently approved policy JSON outside
the checkout in owner-only files. In the template, replace a complete source,
destination, or test selector with a JSON object such as
`{"$private": "backup_guest"}`. Each role maps to one full selector, including
any port suffix, in the inputs JSON. Reuse a role for selectors with identical
values. Keep protocol, permission, tag ownership, and rule order as approved.

```sh
python3 scripts/infra/keep-storage/check-tailnet-policy.py TEMPLATE_JSON ROLE_INPUTS_JSON APPROVED_JSON
```

Run once per policy or fragment. The command compares the complete rendered
JSON with the approved JSON, including allow and deny expectations. It prints
aggregate counts, returns nonzero on any difference or invalid input, and
writes no rendered file. Use the approved policy owner's validation process
to check live identities and enforcement before publication or application.
