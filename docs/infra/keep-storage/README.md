# Keep storage session #254

Status: **coordinated encrypted backup and manual PBS and B2 application recovery verified; nightly restore rehearsed and both timers enabled**.
VM 2540 `files` (2 GiB RAM, 40 GiB disk) and VM 2541 `quantself` (4 GiB, 32 GiB) are running.
Both passed their Owner-approved reboot with pinned-key SSH, firewall, Docker and Tailscale active.
Keep and Backup management firewalls are applied; no physical host reboot or existing disk initialization occurred.
Operational authority: #217. Application contract: #253, merged in #259 as `7a0c095c0c1e78cf3d482ae9afd0faa8fb824459`.
This worktree includes that merge. Cutover remains #209; Hostinger is unchanged.

The [private application bundle](deployment.md) is staged on `quantself`, with pinned
PostgreSQL/Caddy images downloaded. The verified application image is loaded (see [image evidence](image-proof.json)); all four application services are healthy and Owner passkey enrollment is complete. Compose
validation proved loopback-only publication, API-only Vault credentials and rejection
of missing required settings. Graceful writer shutdown is implemented and unit-tested; deployed signal handling
and coordinated recovery passed.

## Current endpoints and proof

| Guest | LAN | Tailscale | Role |
| --- | --- | --- | --- |
| files / 2540 | Private LAN address | Private Tailscale IP and DNS name | tag:vault; OpenCloud backend on loopback 9200 |
| quantself / 2541 | Private LAN address | Private Tailscale IP and DNS name | tag:quantself; private app HTTPS 443 → loopback 3000 |

Use the addresses and DNS names from the private deployment configuration.

Vault public-facing TLS terminates in **tailnet-only** Tailscale Serve, not Funnel. Its backend is loopback-only.
Owner and Quantself HTTPS requests verify the trusted certificate (`ssl_verify_result=0`).
Owner completed the Vault/PBS secret helper. Vault returned HTTP 200 with trusted TLS, and Owner browser admin login succeeded. Subsequent [live permission tests](vault-permissions-proof.json) verified app CRUD, Owner view-only originals access, Personal isolation and credential rotation. The Owner-approved Originals quota increased from 1 GB to **10 GB** on 2026-11-14; the UI showed 23.1 MB used. This is the local space quota, separate from the offsite stored-backup target.
`/srv/opencloud/{config,data}` reside on one ext4 filesystem with user xattrs verified; directories are UID/GID 1000 and mode 0700.
The pinned production image and Compose file are installed on files.

The prior private network proof passed 51/51 live checks from Owner, Quantself, Stacy, Tyler and Gate.
Those tests used temporary synthetic HTTP listeners, now removed. They establish routing/firewall behavior, not authenticated application access.
iPhone and CI sources have policy-test evidence only, not live-device tests.

Post-gateway checks on 2026-11-14 verified Files Serve HTTPS 443 routes to
`127.0.0.1:9201`, with OpenCloud 9200 and gateway 9201 bound only to loopback.
Quantself Serve routes to loopback 3000; neither host's Serve configuration enables
Funnel. Quantself exposed neither API 3001 nor PostgreSQL 5432 nor the reserved
webhook 8443 on host listeners. Quantself-to-Vault HTTPS returned 200 with certificate
verification 0. Local Tailscale status showed the expected `tag:vault` and
`tag:quantself`. The Owner console independently showed both connected with
expiry disabled at 06:17 UTC on 2026-11-14.

Fresh strict SSH checks after each VM reboot verified unchanged pinned host keys, correct hostname, active firewall/Docker/Tailscale/SSH,
Owner as sole sudo member, and disabled password/root/keyboard-interactive login.
See [boot evidence](boot-proof.json). The completed cloud-init bootstrap is disabled by `/etc/cloud/cloud-init.disabled`:
the earlier DNS regeneration changed NoCloud instance IDs, and reinitialization must not replace enrolled identities or host keys.
Re-enabling cloud-init requires deliberate reprovisioning review; future guests use the current per-VM hostname template.

## Measured preflight — 2026-11-13 Halifax

Historical pre-provisioning measurement; current guest/network state is above.
Read-only SSH, strict host-key checking, one remote machine at a time.
Keep was reached via its configured Tailscale DNS name using its existing pinned key.
The numeric address has no known-host entry; obsolete `keep` still identifies the old offline node. Neither pin was replaced.

| Keep resource | Observed |
| --- | --- |
| Host | Proxmox 9.2.26; kernel 7.0.14-28-pve |
| SSD | Samsung MZ7LN256HCHP-000H1, 238.5 GiB |
| Encryption | sda3 LUKS -> keep-vg -> root, swap, data |
| Guests | `qm list` and `pct list` empty |
| VM pool | 150 GiB, data 0.00%, metadata 10.43% |
| Unallocated VG | 19.35 GiB |
| Host root | 63 GiB; 54 GiB available |
| RAM | 15,869 MiB total; 14,136 MiB available |
| PBS | `backup`, datastore `main`, `push@pbs!pve`; active |
| PBS client encryption | No `backup.enc` file; no encryption key configured in storage metadata |
| Backup jobs | `/cluster/backup` returned `[]` |
| Firewall | nft ruleset empty; pve-firewall disabled/running |
| Accounts | Owner account is the sole human and sudo member; root is the sole UID 0; Owner account is the sole PVE user |
| SSH | Password/root/keyboard-interactive disabled; one authorized-key file found with Owner fingerprint |

`/etc/sudoers.d/zfs` contains comments only, not an extra active grant.
`90-bringup` remains for #226. No failed units reported.

Hostinger aggregate inventory (no private names/content exported):

| Data | Files/rows | Bytes |
| --- | ---: | ---: |
| Inventory images | 822 | 2,825,809,495 |
| Inventory audio | 16 | 13,548,058 |
| Inventory assets | 0 | 0 |
| To-do captures | 28 | 52,008,530 |
| Receipt rows / embedded image bytes | 38 | 1,376,157 |
| Database logical size | — | 30,643,903 |
| PostgreSQL volume | — | 88,455,461 |
| Codex state volume | — | 67,820,651 |
| Auth-secret volume | — | 65 |

Receipt bytes are already in the database; do not double-count for legacy sizing.
Largest image: 20,754,790 bytes; largest inventory audio: 1,936,783;
largest capture: 14,030,828. Current totals do not establish future recording growth.
All six Quantself Compose services running. Hostinger root: 41/48 GiB used, 6.8 GiB available.
Do not stage a production dump/copy there during this session.

## Allocated capacity and restore admission

- Vault `files`: 2 vCPU, 2 GiB RAM, 40 GiB encrypted-pool virtual disk.
- `quantself`: 2 vCPU, 4 GiB RAM, 32 GiB encrypted-pool virtual disk.
- 72 GiB nominal disks leave 78 GiB of the 150 GiB pool. A full nominal 72 GiB isolated restore leaves only 6 GiB: do not treat that as safe long-term capacity.
- Gate restore by actual allocated bytes plus snapshot growth and a minimum 20 GiB pool reserve. Initial synthetic recovery fits; remeasure before every real restore. Do not oversubscribe thin-pool physical storage.
- Preserve 19.35 GiB VG reserve; no root shrinking or pool expansion in this plan.
- Reserve inside Vault for OS/images, originals, at least 2x largest concurrent uploads, metadata and growth. No personal-document import sized or authorized here.
- Future AI/Honcho VMs require a separate RAM budget; this allocation does not establish that every planned workload fits simultaneously.
- Alert at pool data 70%/85%, metadata 70%/85%, VM filesystem 75%/85%; block bulk import/restore when projected reserve fails. Alert delivery still requires setup and a witnessed failure test.

## Release and proof

OpenCloud production 7.2.5 is selected and locally proven, manifest digest in
`scripts/infra/keep-storage/opencloud-image.txt`.
Verified against official release lifecycle and registry manifest on this session's date.
AMD64 manifest: `sha256:50b37693022a25b4f8e3eb1c82c813a3afb53456a33889a5723dc8f0326e94ba`.
The admin UI exposed the critical 7.2.5 update; official release notes include security fixes. Local proof passed again on 7.2.5. Live Vault was updated to the pinned 7.2.5 image after account setup. `opencloud version` reported stable 7.2.5; HTTPS returned 200 with TLS verification 0.
The production channel is distinct from #252's rolling image; no automatic tag updates.

Run `scripts/infra/keep-storage/run-production-proof.sh` on the Mac to reuse the isolated #252 proof with this pin. Synthetic local credentials/artifacts remain private; publish only sanitized results. Result: all 17 checks passed on production 7.2.5; 57 explicitly instrumented OpenCloud requests (browser/background and media requests are not included in that count). See `production-release-proof.json`. This does not prove Keep performance, trusted TLS, PBS encryption, or real application integration.

Sources: https://docs.opencloud.eu/docs/admin/resources/lifecycle/
and https://github.com/opencloud-eu/opencloud/releases/tag/v7.2.5 .

## Applied network policy

The approved deployment policy is kept with the private infrastructure. The Owner gave named approval; policy was saved after server-side tests passed. Fresh Owner SSH and existing Keep/Atlas PBS paths were verified after application. Future policy edits still require #217's named approval.

The initial allow-all grant, default Tailscale SSH rule and Funnel attribute were removed. Use OpenSSH with the Owner key; never enable Funnel for Vault.

Owner explicitly approved excluding all legacy devices, including the unexpected untagged `hermes-agent`, home-dell, myinstance, e2-micro and obsolete keep. Exact Mac/iPhone IPv4 + IPv6 sources avoid admitting untagged Agent machines through a user-wide grant. Review selectors if Owner devices are re-enrolled.

| Source | Destination / port | Purpose |
| --- | --- | --- |
| Owner Mac/iPhone only | Six current hosts + new Vault/Quantself tags | Owner administration and browsing |
| Current Atlas + Keep IPs | Backup TCP 8007 | Existing PBS pushes |
| tag:quantself | tag:vault TCP 443 | Restricted application WebDAV identity |
| tag:agent | tag:quantself TCP 443 | Application API authorization remains mandatory |
| tag:ci | tag:quantself TCP 22 | #209 deploy identity; no Vault access |
| tag:dmz | tag:quantself TCP 8443 | #209 dedicated webhook-only listener |
| Other sources/pairs | Deny | No broad tag:data or tag:infra Vault access |

Port 8443 is a proposed #209 contract, not an existing service. Keep it closed until an allowlisted gateway is implemented and tested. Network grants cannot enforce HTTP paths. Existing agent gateway/AI ports are not guessed or pre-opened.

Keep boot unlock stays Mac -> Atlas SSH -> Keep’s configured LAN address on port 2222 with the existing separate boot key and Owner-entered secret. Dropbear is unchanged; no new physical Keep boot-unlock test has been performed.
Guest nftables input/forward rules deny LAN service bypass including Docker DNAT and IPv6; incoming Docker rules match the original destination port.
The enabled guest firewall unit runs before Docker, Tailscale and SSH and passed VM reboot checks.
With separately named approval, Keep blocks non-tailnet SSH/Proxmox 22/8006 and Backup blocks non-tailnet SSH/PBS 22/8007, IPv4+IPv6.
Fresh Owner sessions, Keep/Atlas PBS access and local Proxmox service remained available. These changes do not claim to harden unrelated Atlas services.

The Mac's `keep` SSH alias now explicitly targets Keep’s configured Tailscale DNS name with
strict host-key checking. Fresh normal `ssh keep` returned hostname `keep` and
the Owner account, using the existing trusted key. Server SSH settings and the
separate preboot-unlock path were not changed.

## Recovery and secret handoffs — partial execution

Owner selected **Backblaze B2 Canada East (Toronto), encrypted nightly database + originals backups**, after reviewing the [broad comparison](offsite-backup-comparison.md). Initial stored-backup target is 10 GB, with room for modest growth. The private bucket and separate guest credentials are configured. Both guests passed live Native/S3 access-denial probes and encrypted restic synthetic backup/check/restore; [cloud evidence](b2-access-proof.json) records their scope. Hidden versions remain readable and permanent deletion is denied to the guest keys. This is not a coordinated application backup or a damaged-repository recovery drill. Owner retains independent recovery material; never put secrets in chat, GitHub or Git. This selection is recorded in ADR 0045; [implementation constraints](offsite.md) separate the guests' credentials. Checksum-verified restic 0.19.1 is installed at `/usr/local/bin/restic`. Both primary repositories are initialized with distinct authenticated IDs recorded in the cloud evidence; the first coordinated encrypted PBS and B2 backup pair is complete. [Pair evidence](first-pair-proof.json). The metadata/growth comparison selected restic over Kopia with archive staging; see [offsite design](offsite.md).

1. Owner enabled PBS client encryption on the existing `backup` storage. Nonsecret checks verified the encryption-key setting, root-owned mode-0600 key file on Keep, active PBS storage, and mode-0600 Mac recovery export. Owner confirms independent retention. **Off-host recovery is not yet tested**; restore must use that copy, not Keep's original key. Agent never reads/prints the key.
2. Consume [#253's merged contract](../../opencloud-originals.md): apply `20261114010000_original_files` before API startup; explicitly select `opencloud`; pass scoped Vault credentials only to the API. Pause all API instances with `QUANTSELF_ORIGINALS_WRITE_PAUSED=1`, drain/stop API and processing/conversion workers; do not assume changing an environment variable drains existing requests.
3. Lock one backup run, pause all writers, drain uploads/deletes, dump Docker PostgreSQL, stop OpenCloud per its consistent-backup requirements, and capture both VMs under the same manifest. Include config/system data, PosixFS metadata/xattrs, originals and database metadata. Resume reliably on failure; never publish a partial pair as a valid restore point.
4. Manifest must link app commit/schema, image digests, dump checksum, spaces/file IDs/hash inventory and both PBS snapshot IDs. Keep manifests with private names inside encrypted backup storage.
5. The selected offsite method must contain the same complete restore point (not independently timed live trees), encrypt before upload, and verify success remotely. Owner supplies the chosen provider's scoped credentials and recovery material locally. Keep destructive retention authority separate from daily uploader where feasible; test repository permissions rather than claiming append-only behavior from role names.
6. Isolated Keep destination, no production routing/notifications: restore both sides with keys retrieved off-host; verify counts, stable IDs, hashes, app receipt rendering and recording playback/seeking, Owner Viewer/app Editor/private-doc denials. Restart storage and rotate/revoke the app token; repeat access checks.
7. Schedule only after manual complete-pair recovery passes. Prove an alert on intentionally failed synthetic backup and a missed heartbeat. Deleting restore VMs requires separately named approval under #217.

After installing the coordinator, the first backup run
failed safely before capture because the API did not drain; the application
resumed and no complete pair was published. The replacement image passed
isolated Next, Caddy and API drain tests and was deployed by 06:56 UTC on
2026-11-14. Live scoped-token verification and B2 setup passed. The first
successful pair completed at 07:05 UTC on 2026-11-14. Manual application
recovery passed for PBS and B2. The no-NIC PostgreSQL rehearsal and VM 2544
cleanup passed. Both timers are enabled. The requested immediate backup
completed at 17:57:32 UTC as `20261114T175509Z-a9414550a6bf`. Its
PostgreSQL restore service verified the same pair and removed VM 2544 and
its volumes. Healthchecks accepted the success heartbeat. [Nightly evidence](nightly-proof.json). [Pair evidence](first-pair-proof.json), [Deployment](deployment.md), [Runtime proof](runtime-drain-proof.json).
Production files, Hostinger writes, public DNS and Seagate staging remain unchanged.

## Closing evidence and #209 boundaries

- At 06:17 UTC on 2026-11-14, Tailscale Machines showed both tagged guests connected with key expiry disabled. Live Vault Editor CRUD, Owner Viewer restrictions, private-space denials and app-token rotation passed. Both prior tokens were revoked and one remains. [Vault permission evidence](vault-permissions-proof.json).
- Fresh account audits cover Keep, Backup, files and quantself. Root SSH remains disabled. Keep retains the documented Proxmox system key and non-login Ceph account under #218. [Account audit](account-proof.json).
- Preserve the physical-host boot unlock. iPhone and CI source results cover policy tests. Live tests remain outside this evidence.
- Removed restore VMs 2542/2543, their four volumes and the isolated lab network. Stopped test proxies and closed the Mac lab tunnel. Owner recovery copies and backups were retained. [Cleanup proof](nightly-proof.json).
- Live PDF receipt upload/download, original image rendering, To-Do audio API reads and Inventory playback/seeking passed. [Receipt evidence](live-receipt-proof.json), [Audio evidence](live-audio-proof.json).
- #209 owns the production cutover, deploy connectivity and dedicated webhook listener.

## Bootstrap and validation update

Historical proof snapshots use redacted endpoint labels.

Initial guest cloud-init inherited Keep's Tailscale-only DNS, unusable before enrollment. Corrected VM metadata to use the LAN DNS server and home search domain; DHCP provided working DNS and bootstrap completed before reboot. Docker, Compose, QEMU guest agent and Tailscale were verified. Owner completed enrollment; both approved VM reboots have now passed. Keep itself was not rebooted.

Before importing #253, `bun run typecheck` passed; `bun run test` (with --isolate) passed 1,734, skipped 12, failed 0. Used a synthetic DATABASE_URL pointing to closed local port 1 for schema generation; no production environment copied. This is historical evidence for that revision, not validation of the later merged application. Owner-helper Bash syntax and shellcheck passed. Network and boot evidence are recorded separately.

After importing merge `7a0c095`, `bun run typecheck` passed and `bun run test`
passed 1,738 tests, skipped 12, failed 0 (378 files; 231.94 seconds). Generation
used a non-production placeholder URL; no database connection was made. The
standalone Keep Compose model also passed checks for loopback-only publication,
API-only OpenCloud credentials, three persistent volumes, and rejection of all
seven missing required settings. These are code/configuration checks, not deployed
application or recovery acceptance. Image build verification was pending at this checkpoint.

Commit `049a608` adds bounded-memory Webpack builds and corrects seven inventory
page signatures rejected by Next's production page contract. Typecheck and 22
affected page tests passed. The full isolated suite passed again with 1,738 pass,
12 skipped, 0 fail in 314.31 seconds when run without a concurrent image build.
A concurrent run hit resource pressure, test timeouts and an image-build OOM;
run these resource-heavy checks sequentially on this Mac. A complete image build
from `049a608` was pending at this checkpoint, before any app image was loaded on Keep.

Shutdown implementation now awaits active HTTP handlers (including disconnected clients), worker jobs and cache work, closes SSE streams, then disconnects Prisma. Deadline failure exits nonzero. Six new deferred-work/stream tests passed; full suite: 1,744 pass, 12 skip, 0 fail, 379 files, 253.94 seconds. At this checkpoint, only code tests had run.

The production image at `0f24648` compiled successfully in GitHub Actions, including Next production type checks, but `docker save` exhausted the ephemeral runner disk. The next build removes Next build caches and releases intermediate Docker cache before export. This is not a deployed-image success claim.

Build `e87aaad` succeeded in CI (run 43546658517). The 726,201,787-byte private artifact passed both SHA-256 checks; its Linux/AMD64 image ID and source revision matched after loading on quantself. All 20 focused tests passed in the exact Bun 1.3.4 image under NODE_ENV=test. The first test invocation retained NODE_ENV=production and correctly failed the missing BETTER_AUTH_URL guard; no runtime service used that test setting. VM disk remains 26 GiB free. The Owner app-secret and startup helper was ready at this checkpoint, before credential setup and service startup.

## Private app startup — 2026-11-14 UTC

Owner completed the corrected app-secret helper. App/API/gateway/PostgreSQL are
healthy; migration and auth-init exited 0. With explicit named approval, enabled
`tailscale serve --bg --https=443 http://127.0.0.1:3000` on quantself. Root HTTPS
returned 307 and API health 200, both TLS verification 0. Owner created the app
passkey; signed-in Today and Budgeting screens were observed, and first-owner
setup now reports closed. To-Do is unavailable because this fresh environment
has no production GitHub integration credentials. No Hostinger data was copied.

Initial startup used the verified app/API image `sha256:fef4d9af7bce109e8b5c6245422df8e01f42af9a117bef8a0f976fb2b48b5530`.
Installed Compose SHA-256: `432dc0b9648ebaaca9fc1b60332c34f4c8f538bab5f35febbc0c8a9d3e0cda29`.
Guest disk: 33,603,391,488 bytes total, 27,465,764,864 available. App token metadata
reports expiry `2027-02-12T03:00:51.455421+00:00`; no token value was inspected.
A fresh browser tab recovered automation access and the PDF receipt round-trip
passed. Later rotation and audio evidence appears in the completion gates above.
[Current deployment](deployment.md).

Validation of the helper/research changes: typecheck passed; four synthetic Owner
helper checks passed. A full isolated test rerun had 1,727 pass, 12 skip, 17 timeout
failures and four consequent asynchronous errors (853.28s). Rechecking the affected
files passed 69/70; the remaining reference-render test passed alone at its unchanged
default timeout (3.40s). No application TypeScript changed in these helper/research
commits. This is not a clean full-suite rerun; prior application revision evidence
above remains dated separately.

### Old B2 account cleanup

Owner approved permanent deletion of `docengine-bucket` and all versions, and
revocation of `docengine-key`. The old account is US East, endpoint
`s3.us-east-005.backblazeb2.com`; Owner chose a separate Toronto account instead
of reusing it. Revoked the unrestricted legacy key, deleted the five current
objects (about 2 KB), verified zero unfinished uploads, waited for the bucket
count to update to zero, then deleted the empty bucket. The buckets page is now
empty. The old account itself and its master-key state were not changed.
Owner requires the designated private email for the new Toronto account; changing
the empty old account email is the current handoff. Reusing cleaned US East is an
accepted fallback at that stage, before the new backup buckets and uploads were created.


## Live synthetic receipt check — 2026-11-14 UTC

Authenticated Owner uploaded a 792-byte synthetic PDF through the actual private
app with “Archive originals only — no OCR.” UI showed one archived receipt; the
original download matched the source SHA-256 exactly. A read-only query of the
Docker PostgreSQL ledger confirmed OpenCloud provider, ready state, file/space ID
and no inline database image bytes. See [receipt evidence](live-receipt-proof.json).
The first diagnostic join omitted the application's `original:` reference prefix;
the corrected join proved the relationship. This was a query error, not missing data.

The app's PDF detail view renders its archived status and download link; it does
not embed the original PDF. Browser upload of the larger PNG was interrupted at the native file picker.
The deployed adapter then uploaded that 5,763,517-byte synthetic PNG in 971 ms,
with seven upstream requests; two full hash-verified reads took 161/159 ms, one
GET each. These are timings inside the API container, not browser upload or
cold-cache measurements. The actual authenticated Owner UI subsequently rendered
the original image correctly. Both synthetic receipts were retained for the later manual restore drill.

The independent [recovery inventory](restore-inventory.md) now passes 12 isolated
Linux checks and an encrypted restic 0.19.1 round-trip. Both production guests had
the verified pinned restic binary at this checkpoint, before backup timers and repositories were created.

Validation for the independent inventory/live receipt work: 12 isolated Linux
fixture tests passed; native restic encrypted restore passed the same verifier.
`bun run typecheck` passed with a synthetic schema-generation URL (no database
connection). Full `bun run test`: 1,738 pass, 12 skip, six timeout failures,
379 files, 483.49s. All six failed tests passed together at unchanged timeouts in
a targeted isolated rerun (11.23s). This is not a clean full-suite result.

## Recording and runtime shutdown evidence — 2026-11-14 UTC

The deployed capture service stored an 8,640,044-byte, 90-second generated WAV
in 1,317 ms. Full reads took 214/185 ms; prefix, middle and suffix ranges took
99/99/127 ms. All bytes matched the synthetic source; an out-of-range request
returned 416. Each read used one upstream GET. These are in-container service
measurements, not browser or cold-cache timings. See [audio evidence](live-audio-proof.json).

A separate copy was uploaded through the authenticated Inventory item UI using
Chrome's native file picker. The built-in player decoded all 90 seconds, sought
to 87 seconds, resumed with no media error and reached the end. The database
ledger confirms the source hash, OpenCloud file ID and ready state. This proves
the Inventory player; direct navigation to the To-Do capture media URL remained
browser-blocked. Both originals remain for recovery acceptance. No transcription
or OCR provider was invoked; the synthetic Inventory item is queued for processing.

The exact deployed Next and Caddy images passed isolated deferred-request drain
tests on Quantself. Caddy refused new connections while preserving an admitted
page request and SSE stream; Next completed downstream requests during shutdown,
exited 143 with its completion marker and no OOM, and Caddy exited 0 after the
stream closed. [Runtime evidence](runtime-drain-proof.json) records the sequence.
The test did not stop the live deployment. A separate exact-image API fixture
also passed: an admitted capture write held by a database lock persisted after
SIGTERM, then the API emitted its drain marker and exited 0. The [OpenCloud fixture](vault-drain-proof.json) also passed when the upload
finished and two unfiltered session scans were empty before stopping it. Stopping
during an admitted upload instead produced PUT 201 followed by persistent GET 425
after restart. The coordinator waits for upload completion. The Vault ingress
gateway is deployed on loopback port 9201, and its private Serve route was
verified. The first coordinated backup completed clean pause and resume on both guests. [Pair evidence](first-pair-proof.json).

Backup coordination, monitoring and local-retention helpers are installed.
The backup timer is enabled for 03:00 and the restore timer for 04:30
America/Halifax. The Owner installed the three Healthchecks
URLs and completed the B2 credential handoff. Live cloud permission probes
passed. The first encrypted pair completed and Healthchecks accepted its backup
and growth heartbeats. Independent-key PBS and B2 recovery passed. Backup
terminal-failure, missed-heartbeat, growth and synthetic PostgreSQL restore
alert delivery passed. The no-NIC rehearsal and cleanup are verified. See
[nightly evidence](nightly-proof.json). [Pair evidence](first-pair-proof.json). [Operations guide](backup-operations.md).

Validation of the backup helper work: 103 Python tests passed in isolated Linux
with no skips. `bun run typecheck` passed. Full `bun run test`: 1,742 pass,
12 skip, two failures and one related unhandled error, 379 files, 392.74s.
The Habits timeout passed in an unchanged-timeout five-test rerun (1.81s).
The supervisor test found an existing local listener on port 47329; all 13
supervisor tests passed in an isolated Docker network. The first Docker rerun
had a non-executable temporary filesystem; enabling execution for its synthetic
test launcher resolved that environment failure. This is not a clean full-suite
result; the existing local supervisor was left running.
