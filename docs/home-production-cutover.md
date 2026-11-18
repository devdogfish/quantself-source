# Home production cutover and recovery

[#209](https://github.com/devdogfish/quantself/issues/209) owns this cutover. [#208](https://github.com/devdogfish/quantself/issues/208) tracks the roadmap. Use the [infrastructure workflow](agents/infrastructure-sessions.md). Follow [#217](https://github.com/devdogfish/quantself/issues/217) for every live command, one machine at a time. The Owner handles secrets privately and gives a named yes for disk initialization, deletion, reboot, SSH, firewall and Tailscale changes. Agree the migration window and the routing changes with the Owner before execution.

> **Owner decision, November 14:** The private origin is `https://qs.girke.dev`; Spaceship remains authoritative with its existing nameservers and DNSSEC. The staged Cloudflare zone is inactive. Existing passkeys and `dashboard.girke.dev` stay available on the rollback deployment until the approved Mac and iPhone sign in automatically to the existing Owner account, real scoped Agent calls pass, and live signed webhooks arrive. Simplify the app’s Owner authentication by relying on Tailscale identity. The earlier synthetic candidate predates this authentication change.

Build the home stack fresh and transfer Quantself's authoritative data and
its required identity and recovery state. Portfolio tracking and the Oona
gallery contact form remain live through the Hostinger exit. Treat the
contact form as a standalone service at `api.girke.dev/api/v1/oona/contact`.
The legacy Girke API, Whisper/OCR deployment, Hermes and YouTube Strategy
Boards are outside the migration. Pause Inventory OCR/transcription
preprocessing on Keep until the Owner chooses a replacement. Preserve the
original media, completed results and job rows. Owner-local portable n8n
exports include six Client Relay workflows, one SQLite workflow and the
portfolio workflow. The Hostinger scan found no n8n runtime or export.
Hostinger remains the rollback source through verification.

## Admission

| Gate | Evidence | Cutover result |
| --- | --- | --- |
| #253 application adapter | Closed. Additive migration, five legacy categories, resumable copy and rollback tested with OpenCloud 7.2.0 and Docker PostgreSQL 18. [Contract](opencloud-originals.md), [validation](validation/2026-11-13-opencloud-integration.md). | Recheck the actual candidate revision and image. |
| #254 private Keep environment | Closed. OpenCloud 7.2.5 PosixFS and Docker PostgreSQL 18.7, trusted private HTTPS, scoped storage identities, 146.5 GB pool free at handoff. Encrypted PBS and B2 application restores proved independently with synthetic data. Latest reported pair `20261114T175509Z-a9414550a6bf` and the nightly zero-NIC PostgreSQL drill succeeded. [Handoff](infra/keep-storage/README.md), [nightly evidence](infra/keep-storage/nightly-proof.json). | Revisit capacity and produce a paired recovery point for the actual production bundle and records. The iPhone and CI selectors have policy test evidence. Require live checks. |
| #209 private target and edge | Both authoritative Spaceship servers resolved `qs.girke.dev` to Keep and cleared the challenge TXT. The Let's Encrypt certificate verified on loopback and from the Mac over tailnet TCP 443 with ordinary DNS resolution. Tailscale Serve was restored and synthetic health returned 200. Gate's synthetic Funnel proof passed. The approved deployment policy is kept with the private infrastructure. | Test iPhone DNS and Owner access from both approved devices after the production handoff. Prove a real ephemeral CI deploy, live webhooks and direct-path denials. |
| #209 production data and services | Hostinger remains the source. The Keep instance is synthetic and starts with a different auth identity. Its Compose has three volumes and omits production integrations and workers. [Deployment handoff](infra/keep-storage/deployment.md). | Inventory live state read-only, validate a staged production candidate, restore a production recovery pair and approve the switch. |

Record the exact app revision/image IDs, migration names, Vault pin, actual allocated RAM/disk and staging bounds, the allow/deny probe results, private artifact references and Owner approval. Use the [Keep admission limits](infra/keep-storage/restore-runbook.md#owner-approval-and-admission) with current pool data and metadata usage. Size guest scratch for the logical dump, image archives, encrypted transfer/staging, conversion volumes, OpenCloud growth and one full restored pair. Treat simultaneous backup, deploy, conversion and restore work as competing for both space and writers.

The deployed #254 backup coordinator currently expects exactly gateway, app, API and PostgreSQL in the `keep-quantself` Compose project. It rejects unexpected running services and its B2 freeze explicitly captures PostgreSQL, capture volume, auth volume, runtime config and the app image. The production profile in this branch adds the two Inventory workers and the separate `portfolio-analytics` project. When rehearsed and approved, enable it on the Quantself guest with root-owned mode 0600 `/etc/keep-backup/production-profile.json`:

```json
{"format":1,"app_path":"/opt/quantself-production","analytics_path":"/opt/portfolio-analytics"}
```

Use the actual absolute paths. The profile checks the active gateway mount and image, drains both Inventory workers before the API, and shuts down the analytics relay, retention and Umami before dumping its database and roles. It backs up Codex, auth, captures, mounted legacy inventory volumes, matching application image, and both private runtime bundles. The deployment env copy is a recovery reference: clear the old activation approval on restore. The encrypted roles dump contains password hashes. Include independently recoverable host Caddy config/state, the Hostinger and Gate relay configs, and credentials from the Owner's protected backups.

The backup and deployment share a lock. A durable maintenance marker blocks deploy until the coordinated backup restores the exact service state. Use the [installed recovery procedure](infra/keep-storage/backup-operations.md#run-and-recover) before clearing any uncertain backup state. Rehearse an isolated production pair from **both** PBS and B2, including the two databases and Codex, before enabling the new profile live. The nightly PostgreSQL drill can check both production databases in the no-NIC clone. Admission requires a distinct Owner-recorded rehearsal receipt with the production profile, both exact PostgreSQL image IDs, the existing PBS key fingerprint and successful full and no-NIC restore proofs. Preserve the old backup policy until that handoff is ready.

For the native analytics release, use format 2 in the same root-owned profile after the historical import and report acceptance. The Quantself database contains the analytics tables. Its paired manifest uses `production-native` and requires the verified release, application data and Vault originals. Preserve the frozen Umami dump and the last complete two-database pair for rollback. Keep the Owner ingress and worker hold in place until the independent PBS/B2 restore passes, since guest services resume before the B2 upload finishes.

```json
{"format":2,"app_path":"/opt/quantself-production"}
```

Native nightly recovery requires a separate Owner rehearsal with the exact PostgreSQL image and encryption fingerprint, the full pair, and a zero-NIC PostgreSQL-only restore. After proof, stage the receipt at `/etc/keep-backup/postgres-restore-native-rehearsal.json`. The nightly drill checks the complete migration ledger, both native analytics tables and the absence of old analytics containers.

The synthetic rehearsal restored pair `20261114T175509Z-a9414550a6bf` into VMs 2542 and 2543. Both passed zero-NIC boots and shut down. The lab bridge dropped both host-bound probes. On VM 2543 the initial app image verified legacy startup. [Revised Linux image `c0f187f`](https://github.com/devdogfish/quantself/actions/runs/43631495855) passed typecheck and 1,810 tests. The disconnected clone applied migrations, mapped trusted ingress to its pre-existing synthetic Owner without issuing a session, denied spoofed access and foreign-Origin writes, rendered Settings and served bundled catalog images. API health passed. Its separate drain drill completed deferred HTML and SSE, preserved the admitted write and exited cleanly after active and abandoned SSE and a partial WAV client reset. Both clones remain stopped with zero NICs. Repeat the image-bound drain for the approved production release.

[Linux candidate `e916713`](https://github.com/devdogfish/quantself/actions/runs/43636887500) includes the legacy tax archive and passed typecheck and 1,841 tests with 17 skipped. The exact image passed migration, Owner-auth and the full runtime drain on disconnected VM 2543. Both clones were verified stopped with zero NICs after the checks. Separate Docker fixtures verified both logical dumps and restores, the analytics reader's SELECT-only grants, checksum matching, and exact field preservation in the tax archive. The production recovery pair remains pending.

The approved Hostinger rehearsal captured both databases and the four media volumes at point `20261114T212034Z-53f5a97bd5b6`. The dashboard returned 503 while fenced and recovered to 200 after capture. Oona preflight remained 204. Rehearsal attempts identified IPv4-mapped health probes, idle upstream connections and a legacy Inventory worker exit 139. The successful capture drained Quantself's dedicated Caddy, verified quiet database and Inventory state, paused the remaining writers and resumed them in place. The verified snapshot streamed to encrypted Keep storage without a local file. Auth-secret files and Codex state remain at the source. Production cutover requires a fresh capture.

With no NICs on VM 2543, the checksum-verified copy restored 71 Quantself tables with 13,424 rows, 27 analytics tables with 898 rows, and all four media archives. File content hashes and numeric ownership matched. The candidate migration verified the existing Owner and original-file schema and preserved all seven legacy tax rows with an identical archive digest. VM 2543 was stopped after verification. Authenticated app playback and the production backup pair remain pending.

The read-only conversion inventory on VM 2543 found 499 referenced originals totaling 2,876,023,802 bytes. This includes 423 images, 16 Inventory audio files, 22 capture audio files, and 38 receipts. The four volume archives also hold files outside the conversion inventory, including capture metadata. Retain the complete archives and reconcile unreferenced media before treating the conversion count as the full storage inventory.

The disconnected OpenCloud 7.2.5 rehearsal on 2543 converted all 499 originals and reread each through its stable Vault space and file ID. Checksums matched the 2,876,023,802-byte manifest. Rollback restored the complete legacy reference inventory. Conversion took 5m 34s, checksum replay 1m, and rollback 1m 20s. The 32 GiB root had 3.55 GiB free after restore. An approved new 8 GiB encrypted scratch disk provided 7.36 GiB free without resizing the root disk. The first upload failed before a reference changed because the Vault advertised an origin it could not reach from its container. The same candidate adapter passed a synthetic upload and range read after the Vault and converter shared one trusted HTTPS origin. The resumed conversion reused the original database and Vault. The source archives were retained. The Editor token was revoked and denied on retry. Scratch is excluded from routine VM backup. VM 2543 is stopped with zero NICs.

The dedicated `deploy` account on VM 2541 has the approved CI public key and a forced command. A fresh Owner SSH login succeeded, unsupported commands were denied, and the socket is restricted to `deploy`. GitHub deployment remains disabled pending Tailscale CI credentials and a live smoke run. VM 2541 now has the verified root-owned production checkout and analytics relay bundle in `/opt/quantself-production` and `/opt/portfolio-analytics`. Both are staged without runtime environment files. The synthetic stack remained healthy.

The merged [Linux candidate `4d73517`](https://github.com/devdogfish/quantself/actions/runs/43646389173) passed typecheck and 1,865 tests with 17 skipped. The root-owned VM 2541 release archive passed metadata, checksums and Docker image config verification for `sha256:aca66e7d3ce531f2888febf05d4bb0c1a5778e71237dee454ad2ea9f2850c121`. The matching zero-NIC VM 2543 drain proof passed deferred Next HTML and SSE, the admitted write, clean API exit, and a reset WAV range client. VM 2543 stopped after the proof. The VM 2541 archive and mode 0600 `web-drain.json` passed the production release verifier together. Production activation and the exact-main release remain pending. Mac typecheck passed. Six tests failed in the full Mac run and all 48 tests across the six affected files passed in the isolated rerun.

The read-only Spaceship baseline captured 14 matching `girke.dev` records in root-only `girke-dev-dns-20261114T223544Z.json` under the VM 2541 staging directory. The stable record digest is `bf25a905725d04df4c8bd5f59b16dd69e0e5b84f3192eb2876514973e41d2aa3`. Two authoritative servers independently returned the expected private A record and no ACME TXT. The parent DS record was present. Use the [DNS runbook](infra/girke-dev-dns.md) to compare a fresh snapshot with this historical baseline and any approved changes since it. The mail domains are tracked separately by #278.

At candidate `cf61773`, a synthetic Owner context authenticated and both redesigned analytics routes returned 404. Existing ingestion passed seven tests. The current [#289 reports](https://github.com/devdogfish/quantself/issues/289) use the [#301 event store](https://github.com/devdogfish/quantself/issues/301) and [#302 tracked links](https://github.com/devdogfish/quantself/issues/302). Retain the protected source Umami archive from point `20261114T212034Z-53f5a97bd5b6` for the #301 import. The historical `48ca48e` rehearsal exercised the superseded report implementation in isolation.

The inactive deploy dispatcher on VM 2541 now has its root-owned nonsecret paths set. The static configuration contains no GitHub credential. A [separate GitHub job-token probe](https://github.com/devdogfish/quantself/actions/runs/43649464589) used Contents read and Actions read to fetch private main and read both its active workflow run and the prior verified candidate run. The code-only replacement passed a disposable pinned OpenSSH and socat test with both credential transfer and token-free preflight. It rejected embedded NUL, trailing input, a mismatched run ID, and a stale main SHA. The fixture proved the token was scoped to the fixed Actions lookup and private Git fetch. A second fixture kept the older deploy script in the worktree and verified that the dispatcher ran only the script from the fetched, approved commit. VM 2541 now runs both restricted SSH scripts from `e9f930a`. The original pair and install journal are retained under the root-only staging directory. A fresh Owner SSH login succeeded while the original session remained open. A live local socket probe rejected an unapproved revision before GitHub. The earlier staged checkout remains until deployment fetches the approved main revision. GitHub deployment remains disabled. No permanent GitHub credential was installed. GitHub lists both scoped Tailscale secret names. A VM-local token-free preflight reached the expected missing runtime configuration gate. Credential usability from protected GitHub Actions and the healthy runtime checks remain pending.

[Linux verification for `e9f930a`](https://github.com/devdogfish/quantself/actions/runs/43651192210) compiled the image, ran typecheck and passed 1,888 tests with 17 skipped. That run used verification-only mode. The exact activation candidate still needs an exported image and the release-specific proofs.

The final capture kit preserves the active auth settings, the auth-secret volume and Codex state with the same protected point as both databases and the four media archives. The Keep config staging helper passed both source auth modes against the real Compose model using synthetic values, including multiline keys, literal dollar signs and a spaced Vault token. It validates the paused Inventory profile and stages private app and analytics config. The code-only toolkit is checksum-verified on VM 2541 in the root-only `runtime-toolkit-2659fceb5a25` staging directory. The final capture and runtime environment installation remain pending.

The home Compose model applies the [#287](https://github.com/devdogfish/quantself/issues/287) private Jobs file mounts. The API gets only its email routes and the web gets only its candidate rules. Both bind mounts are read-only. The deploy script checks each file under its service identity before migration. Run the three [status-only checks](../scripts/jobs/README.md#stage-and-roll-back) against the reviewed private inventory. The production backup captures both files with the app point and audits their restored hashes, ownership and permissions. The [restaging steps](home-production-deploy.md#restore-private-jobs-configuration) are required before starting the recovered app. The future [Jobs rebuild](https://github.com/devdogfish/quantself/issues/293) can change this contract after its backend is ready.

The archived `48ca48e` image was recovered from the native disconnected synthetic pair `20261115T004407Z-237227728463` on VM 2543. Two independent local restic repositories on the existing encrypted scratch disk verified their snapshot contents and rebuilt both trees. The production-format audit verified 42 app entries and 10 Vault entries. The restored Quantself and Umami logical dumps opened in fresh PostgreSQL fixtures. A known WAV's hash, length and stable reference agreed across the restored app and Vault trees. The synthetic Umami reader selected its retained row and denied writes. Both Jobs files retained root ownership and mode 0600 and were readable only in their role-specific read-only mounts. The first setup failed during shell cleanup; the same point resumed after admission confirmed its empty staged archive. Keep recorded the verified receipt and VM 2543 powered off with zero NICs. The paired test used synthetic data and local repositories. Live paired PBS/B2 recovery remains a cutover gate. Retain the existing production-source Umami archive for [#301](https://github.com/devdogfish/quantself/issues/301)'s import.

The [#301](https://github.com/devdogfish/quantself/issues/301) importer from `e608ad4` dry-ran against the retained Umami restore from `20261114T212034Z-53f5a97bd5b6` on zero-NIC VM 2543. Its existing read-only source role and disposable destination were reachable only within the clone's internal Docker bridge. All 273 scoped events were accepted, with zero rejected and zero inserted. Source table counts were unchanged, and the destination stayed empty. Keep recorded `209-umami-import-dry-d509d8afd1a8.json` and verified the clone shut down. Repeat against the final frozen source before applying the import.

The candidate `e511336` includes [draft #305](https://github.com/devdogfish/quantself/pull/305). It passed typecheck and five Jobs Docker fixtures on the Mac. The synthetic Chrome portal verified the Owner revision, private-answer resume, one guarded submission and replay of its saved receipt. Repeat on the combined Jobs API and runner release.

## Source inventory

Record the live deployment revision, Compose projects, stateful containers and host services, mount names/destinations and numeric ownership, database engines/schema, and secret configuration **names**. Use `docker compose ps`, `docker ps` and selected mount/service inspection fields. PostgreSQL runs only in the verified project Docker container. Resolve any divergence from the [current production Compose](../compose.prod.yaml) and [base Compose](../compose.yaml) before transfer. Keep private paths, row/file IDs, individual hashes, environment files and logs in Owner-controlled encrypted evidence. Issue updates contain aggregate counts, bytes, timings and pass/fail only.

| Source | Capture and prove |
| --- | --- |
| `quantself_postgres` | Complete logical Docker PostgreSQL dump and schema/migrations. Verify real restore, per-table counts and relevant reference counts. Includes receipt inline originals, passkey/auth/session records, inventory metadata and pending jobs, application-link registry, private records and other app tables. Retain needed application field-encryption keys. #254 preflight measured 30,643,903 database bytes including 1,376,157 receipt bytes in 38 rows. |
| `quantself_inventory_uploads` | Inventory image bytes and reference manifest. Historical count 822 files / 2,825,809,495 bytes. |
| `quantself_inventory_audio_uploads` | Inventory audio bytes and reference manifest. Historical count 16 files / 13,548,058 bytes. |
| `quantself_inventory_asset_uploads` | Inventory attachment bytes and reference manifest, including an explicitly empty category if current count is zero. |
| `quantself_todo_captures` | Whole capture archive, including JSON, transcripts, indexes/metadata and original audio. Historical count 28 files / 52,008,530 bytes for the whole volume. Record separate referenced audio counts and bytes. Keep capture JSON on the app volume after migration. |
| `quantself_auth_secret` | Preserve the active production secret and file ownership. Read-only inspection confirmed that the live API has an explicit `BETTER_AUTH_SECRET` override and the volume also contains a fallback file. Preserve the effective override through the private credential handoff. Restore with the auth rows and preserve the Hostinger passkey settings for rollback. The home runtime uses `BETTER_AUTH_URL=https://qs.girke.dev`; the existing user ID remains authoritative. |
| `quantself_codex_home` at `/codex-home` | Preserve private worker login/config/state volume and ownership. Owner checks login status in the approved production worker; inspect no token or login file contents. Include in recovery scope even if the worker starts later. |
| Production environment, ingress and deployment | Preserve old and new release artifacts, Compose/Caddy and service definitions, backup jobs, networking, DNS/TTL/DNSSEC state, vendor callback destinations and writer start/stop state. Owner preserves active app secrets, VAPID keys, provider/signing credentials, worker keys and the private fields key through private handoff. Check other non-volume service state and scheduled jobs. |
| GitHub and external integrations | GitHub owns task source data. App cache can rebuild. Preserve integration configuration and record source/app permissions, tokens/keys through Owner handoff, and active callbacks. Deduplicate or reconcile external effects from both stacks before replay. |
| Portfolio analytics and application links | Identify the live collector, retention writer and dedicated Umami PostgreSQL volume, which owns analytics history. Move the analytics project with its preserved UUID, history and reader privileges to Keep. Record a verified backup and recovery location. Verify the scoped reader over its private tailnet path. Verify live Vercel GET/POST registry behavior before privatizing the dashboard and after switching the token-scoped route to hooks. Registry data is in Quantself PostgreSQL. [Current contracts](website-analytics.md). |

Historical totals came from [#254 preflight](https://github.com/devdogfish/quantself/issues/254#issuecomment-6868343290). Recount under the final writer freeze. Compare filesystem inventory with the conversion inventory and classify unreferenced files, duplicate content, derived files and pending or deleted ledger states. Preserve source copies through rollback review. Do not silently drop bytes absent from conversion inventory.

Before the Tax Planning replacement migration, record the frozen row count of `budget_tax_entry`. After the migrations, compare `budget_tax_entry_archive` against the frozen source by its composite key, revision, command ID and complete JSON value. The archive preserves the historical records for later review and import.

## Private rehearsal on Keep

1. Admit fresh disposable encrypted staging and a clean, or explicitly designated, app database and originals space. Preserve the running synthetic environment and its recoverable baseline. Keep production vendor secrets, DNS, notifications, GitHub writes and public inbound delivery disconnected. For any Owner-approved rehearsal using production data, enforce a restore-only network and encrypted evidence storage, with access limited to the Owner. Use synthetic data for outbound and write tests.
2. Reproduce the deployed production bundle with proven pins, an app-scoped Editor token and trusted TLS. Rehearse dashboard hostname/SNI using a private Owner-only mapping or isolated trusted test names. Alternate names can prove startup; separately verify automatic Owner sign-in on `qs.girke.dev` from the approved Mac and iPhone. Use read-only legacy inventory images, audio and asset mounts for conversion, and a writable **copy** of the capture volume for JSON reference updates. Verify the Docker target and migration order, including `20261114010000_original_files`, before API startup.
3. Use a complete representative DB and files copy. Rehearse full logical import, capture metadata, auth and Codex recovery and candidate worker behavior. Use a reviewed CLI environment with the intended database, legacy roots and dedicated Vault identity. Run `inventory`, then `convert` with API/workers stopped. Exercise `resume` after an interruption, verify both intended target and original frozen source, and rehearse `rollback` against the mapping on the disposable copy. Use the exact commands in [Session 1's contract](opencloud-originals.md#conversion--rollback).
4. Compare frozen counts and bytes for all five categories against the mapping and restored records. Independently read referenced OpenCloud bytes by stable space/file ID, compare SHA-256, verify IDs resolve to the correct owners, and verify capture JSON points to the right audio. Keep the manifest mode 0600 and encrypted. Investigate every mismatch and unresolved upload/delete; preserve both source and destination on uncertain results.
5. Measure dump/copy/convert/resume/restore durations, actual allocation, queue drain, cold and warm authenticated media throughput, and actual WebDAV request counts. Run the acceptance matrix privately where possible. Capture and independently restore a rehearsal pair with the exact candidate bundle and both storage sides. Exercise routing reversal against the private target and establish a measured downtime budget, rollback deadline and recovery-point objective with the Owner.

## Owner-approved production switch

Build the exact live `main` revision after the redesigned [Jobs backend](https://github.com/devdogfish/quantself/issues/293) and the [analytics reports](https://github.com/devdogfish/quantself/issues/289) pass acceptance. Recheck the final Jobs runner, storage and writer scope before the paired backup. Use protected home CI preflight with deployment disabled once the private runtime is healthy, then stage the verified release and prepare the named Owner cutover.

The staged image can follow an Owner-approved fast-forward if the reviewed full image revision already contains current `main` and GitHub allows that operation. Recheck the remote SHA immediately before promotion. If promotion creates a different SHA, build and rehearse that exact revision before setting either backup readiness marker.

The target VM must have the root-private runtime environment, reviewed Jobs files and portable templates, and the matching backup profile. Use the [deployment staging procedure](home-production-deploy.md). Confirm the native portfolio settings as one release and retain the prior portfolio deployment for rollback. [Portfolio caller](https://github.com/devdogfish/portfolio/pull/4)

After the approved revision reaches `main` and the private candidate is healthy, dispatch the protected preflight with deployment disabled:

```sh
gh workflow run deploy.yml --ref main \
  -f request_id="$(date -u +%Y%m%dT%H%M%SZ)-keep-preflight" \
  -f deploy_target=home -f preflight_only=true
```

Match the workflow run to the request ID and main SHA. Require `QUANTSELF_DEPLOY_OK` before enabling deploy. A missing runtime file or failed service check requires reconciliation on Keep.

1. Freeze routine deployments for the window and reserve one controlled candidate deploy. Run the [DNS preflight and compare the Spaceship snapshot to baseline](infra/girke-dev-dns.md#verify-a-dns-change). Stage only the reviewed private dashboard and public webhook records. Use a trusted certificate issued using the Spaceship DNS challenge, and prove `qs.girke.dev` resolves to the Keep tailnet address for authorized devices. Do not activate the Cloudflare zone or change delegations.
2. Stage Gate's webhook-only listener privately. Rehearse the Hostinger-independent Gate Funnel with synthetic requests before moving current public delivery. Funnel uses the Gate `*.ts.net` name. A custom public name requires a different transport, since a standard Cloudflare Tunnel CNAME needs an active zone. Verify provider signatures and token authentication with the chosen hostname, methods and raw paths, plus rejection of arbitrary paths and direct bypass. Prepare reverse settings for all senders and gateways.
   - For the native analytics switch, send the two portfolio ingest POSTs (`/api/v1/website-analytics/events` and `/api/v1/website-analytics/inquiries`) and the tracked-link lookup GET (`/api/v1/tracked-links/{code}`) through Gate to the API. Verify each scoped key, duplicate event and inquiry replays, and an unknown link. Keep reporting, inquiry status changes and link registration on authorized private paths. Preserve the existing collector and registry route for rollback until the portfolio switches successfully. [Ingest #303](https://github.com/devdogfish/quantself/pull/303), [tracked links #304](https://github.com/devdogfish/quantself/pull/304).
3. Record a UTC freeze marker. Pause Hostinger ingress that can write alongside both workers, direct writer jobs, task updates/refresher work and integration deliveries as applicable. Drain admitted requests and jobs, including disconnected clients; confirm clean process exits or explicit quiescence. Inventory and collect the final Docker PostgreSQL dumps for Quantself and Umami, complete media/captures, auth and Codex state, and release metadata in one consistent point. A clean app drain and unchanged final counts are required. Record retry/replay and deduplication expectations for each sender.
   - Before migrating Jobs, stop the legacy Mac supervisor and workers and let active browser and email actions settle. Run `bun run jobs:archive-legacy` from the new checkout against the original Mac Jobs home. Verify the private archive manifest, retain the original outboxes and journals, and resolve pending acknowledgements from the pinned legacy checkout while its matching API is available. Follow the [Jobs recovery procedure](https://github.com/devdogfish/quantself/blob/d1755298d1a080eefdee5078798fe2c489dae644/scripts/jobs/README.md#preserve-legacy-submission-evidence-before-cutover). Keep new submissions disabled until uncertain legacy sends are reconciled.
4. Transfer encrypted through approved channels, confirm checksums, restore to the isolated Keep candidate, apply migrations, and run or resume the conversion under exclusive writer control. Repeat frozen-source counts/hash/reference verification with the final manifest. Keep the legacy Hostinger release, DB and complete volumes available behind the freeze. Keep protected rollback copies available in encrypted storage.
5. Take and validate a production database+OpenCloud pair before opening general writes. Run the reviewed [backup operations](infra/keep-storage/backup-operations.md#run-and-recover) with release-specific writer and data scope. Require one durable complete-point receipt tying the app and Vault, volume IDs, both restic snapshots, schema/image and inventory together. Start one isolated full restore and validate it against the matrix before promotion. If the deadline cannot accommodate conversion and evidence, use the pre-write rollback path.
6. Owner approves promotion with the final evidence and rollback record. Route the private dashboard to Keep and update the exact callback destinations. Start Keep as the only production writer. Confirm the former entry points are closed or controlled and any event replays are deduplicated. Verify the public mail/portfolio and private dashboard paths, then run live acceptance. Take a fresh coherent production pair after the smoke writes and verify the production restoration coverage, including the new records and originals.

## Rollback

Agree the deadline and thresholds before the window. Abort on an unclean drain, incorrect target, unresolved count/hash/ID discrepancy, missing completed encrypted pair, authenticated playback failure, auth/route exposure or hard acceptance failure. Pause both targets and determine whether the new site accepted any durable writes, including integrations or external side effects, before choosing the rollback path.

- **Before new writes:** Keep stays paused. Reverse the exact scoped dashboard record, Caddy/tunnel paths, vendor destinations and analytics settings that changed. Verify effective routing and source health with existing Hostinger deployment and original state. Reopen Hostinger writers only once they are the sole active production writers. Reconcile any queued events before delivery.
- **After new writes:** Freeze Keep and its external producers, capture a paired recovery point, and use freeze markers plus command/event IDs to reconcile post-cutover changes. Restore/replay DB, captures and originals together in a private Hostinger-compatible clone. Existing mapping rollback only restores converted legacy rows and paths. Newly created OpenCloud references need an explicitly tested export or a compatible release that retains access to their paired Vault. After verifying merged counts, hashes, stable references and external effects, reverse routing and promote the verified single writer. Verify a compatible post-write rollback or replay path in rehearsal before opening general writes. If a live rollback cannot replay every required change, leave both writers paused while the Owner decides how to resolve the discrepancy.
- Rehearse the compatible post-write recovery on an isolated Hostinger-shaped target using the approved application image, passkey mode, the original Owner identity and an independently restored Vault with trusted HTTPS. Restore the native Quantself database, including website events and inquiries, at the same closed point as the Vault, app volumes and private runtime files. Keep the frozen Umami dump sealed with the separate pre-write Hostinger rollback materials. After simulating cutover and before freezing the fixture, record a new receipt, capture range read, inventory original, row update, deletion and duplicate event. Recheck each against the restored pair before opening writes. Reconcile external provider effects by the original command or event IDs.
- For uncertain migration/backup results, inspect the same conversion manifest or original backup journal/task before retrying. Preserve both source and destination, mapping and exact routing/worker state. Provider selection alone does not reverse references.

VPS cancellation and rollback copy/original deletion require separate explicit Owner authorization. Hand off final sudo hardening to [#226](https://github.com/devdogfish/quantself/issues/226) after verified cutover.

## Atlas failover from Backup mini

The Atlas restore in [#223](https://github.com/devdogfish/quantself/issues/223) used a throwaway VM. The paired app/Vault restores in #254 were isolated on Keep. An Owner-scheduled Atlas drill needs fresh admission and separate evidence. Backup mini remains the PBS source, with its `main` datastore and pinned TLS identity. Use B2 as the paired fallback if the Backup mini is unavailable.

1. Record why Keep is unavailable, expected data loss using the selected point UTC timestamp, and any writes since it. Stop Atlas coding/untrusted workloads and keep other Atlas VM, Agent and Work networks disconnected from the restore guests. Verify adequate RAM, physical allocation plus restore reserve, an Owner-approved encrypted destination and scratch, unused guest IDs across QEMU/LXC/HA, and approval for those exact new disks and the test boundary. Confirm Backup mini reachability, datastore and snapshot group access from Atlas. Verify the selected point is a **complete** encrypted Quantself and files pair, with manifests and exact volume IDs matching the same restore ID. Choose a pre-incident point if corruption or compromise is suspected.
2. Owner retrieves the independent PBS client key and scoped access privately. Verify the expected key fingerprint and restore authorization without printing values. Follow the [Keep PBS procedure](infra/keep-storage/restore-runbook.md#encrypted-pbs-restore) with Atlas-specific approved node, storage, alias and destination IDs. The referenced Owner helper and examples target Keep. Review a separately scoped Atlas command rather than running them as written. Use a temporary PBS alias with the correct datastore, namespace, fingerprint and Owner key. Restore each VM powered off with auto-start disabled. Observe each exact restore task to success before proceeding.
3. Remove every inherited NIC before boot. Run the [Atlas pre-boot check](#verify-the-two-atlas-clones-before-boot). Verify only destination-owned disks, no other passthrough, shared mounts or source disk references. Boot through the guest agent offline. Disable cloned production Compose starts, Tailscale identity, backup/restore schedules, heartbeats and external integrations. Confirm appliances do not autostart production services. Use an isolated no-uplink test bridge with explicit host/LAN/routing denials, no default route or shared DNS, restore-only TLS and a distinct Owner-only browser profile. Verify the boundary from both guests and API container. Enable only the tester→app/Vault and app→Vault paths. [Lab procedure](infra/keep-storage/restore-runbook.md#private-service-network-and-browser).
4. Restore the paired database, auth, capture and Codex state together with OpenCloud data/config/system metadata, numeric ownership and PosixFS xattrs. Keep file and space IDs intact. Audit both native trees, manifests, exact images and checksums. Read by recorded IDs and compare hashes and bytes. Verify authenticated receipt access and recording play/seek, Owner Viewer/app Editor scope, rejected Agent/outsider access and private docs boundary. If recovering from B2, Owner supplies independent repository read access and both restic passwords; restore the exact matching snapshots into fresh volumes on encrypted storage using [the offsite drill](infra/keep-storage/restore-runbook.md#b2-recovery-onto-clean-application-volumes). Do not seed the B2 restore from PBS.
5. During actual failover, [verify the Keep writer fence and public delivery routes](#verify-the-keep-writer-fence) before connecting clean service identities to the approved tailnet/firewall routes. Apply distinct node identities, approved dashboard DNS and [verified Gate origin](../deploy/gateway/README.md#check-the-staged-atlas-origin), scoped package/deploy and app credentials and backups. Privately verify final TLS, passkeys and end-to-end acceptance before opening writers. Record restore time, data loss, capacity delta and exact checks. Return to Keep only from a new coordinated Atlas recovery point with [Atlas fenced](#verify-the-atlas-writer-fence-before-returning-to-keep) and verified catch-up. Keep coding workloads stopped while private recovery data is present unless the Owner establishes and approves an equivalent boundary. Delete named drill clones, temporary alias/key/network and scratch only with separate authorization after validation.

### Check the Atlas restore destination

For an Atlas-only Proxmox directory storage on dedicated ext4 directly
over LUKS, bind the storage ID and mount path to the approved LUKS UUID.
Use a root-only mount and scratch directory (`0700`), standard
`images/` directory layout, and the `is_mountpoint` storage option so
Proxmox takes the storage offline if the mount disappears.
Use an independent device record for the approved LUKS UUID.

Immediately before restore, run the reviewed helper locally on Atlas
with its sibling Keep storage scripts available:

```sh
python3 -B scripts/infra/keep-storage/atlas_failover_admission.py \
  "$storage_id" "$mount_path" "$luks_uuid" \
  --records-vmid "$records_vmid" --originals-vmid "$originals_vmid" \
  --records-gib "$records_gib" --originals-gib "$originals_gib" \
  --scratch-gib "$scratch_gib" --reserve-gib "$reserve_gib"
```

Budget each guest from the total virtual disk sizes in its selected
archive, rounded up to GiB. Budget peak simultaneous scratch and the
reviewed operating reserve separately. Require `destination_admitted`
for the exact storage and both VM IDs. The helper measures currently
available filesystem bytes once for the combined budget and rejects
an existing destination image path for either guest. Use the same
storage and IDs for both powered-off restores. Remeasure if capacity
or the destination changes. Use a separately reviewed admission check
for any other storage layout.

This check covers storage only. Complete the runbook's workload,
RAM, QEMU/LXC/HA inventory, paired archive and guest network checks
before their respective restore and boot steps.
[Proxmox directory mount handling](https://github.com/proxmox/pve-storage/blob/master/src/PVE/Storage/DirPlugin.pm)

### Verify the two Atlas clones before boot

For the dedicated encrypted directory layout above, use raw destination
images. After each exact restore task succeeds, record the clone's
identities in the private root-owned mode-0600 JSON ledger. Use the
`records` and `originals` keys, each with `vmid`, `upid`,
`clone_identity` (`vmgenid` and `smbios_uuid`), and `disks`
(slot-to-full-volume-ID map). Record `scsi0` and the clone-owned
`ide2` cloud-init CD-ROM if present. Keep those identities pinned
when removing NICs.

With both guests stopped, run the reviewed helper locally on Atlas:

```sh
python3 -B scripts/infra/keep-storage/atlas_failover_preboot.py \
  "$storage_id" "$mount_path" "$luks_uuid" "$private_restore_ledger"
```

Require `preboot_verified` for both recorded IDs. It checks the original
restore tasks, current and pending configuration, HA membership, and
exact raw files on the approved LUKS mount. Hold boot on any discrepancy.
The result describes the observed state. Keep both guests under the
same operator's control from restore through first boot, and recheck
after any configuration change. Keep NICs absent for the first boot
and complete the guest and network checks before connecting either clone.

For a whole-image check, add both `system_disk_gib` and
`system_disk_sha256` to each ledger role being checked. Record the exact
integer GiB size and SHA-256 from an independent, authenticated read of
the selected PBS system disk's complete logical byte stream. Record its
snapshot and archive names alongside the digest. The helper compares the
configured size, raw file length and complete SHA-256 before boot. Require
the role in `whole_image_verified` for this evidence. Roles listed only
under `guests` have the identity and isolation checks.

[Proxmox VM config and pending config API](https://github.com/proxmox/qemu-server/blob/master/src/PVE/API2/Qemu.pm)

### Reconcile the inherited PBS maintenance marker before Atlas promotion

The coordinated production PBS snapshot is taken while the source guest
holds `/var/lib/keep-backup/production-maintenance.json`. A whole-VM
restore carries that marker into Atlas. It blocks deployment and the next
capture preflight until reconciled.

On the isolated Atlas records clone, before enabling production services
or deploy automation, verify the clone against the promotion ledger.
Keep automation and new dispatch disabled throughout. Confirm no Atlas
coordinator run owns the clone and no guest backup or deploy is running
or queued. Take `/var/lib/keep-backup/worker.lock` first, then
`/run/lock/quantself-production.lock`, and recheck those conditions with
both locks held. Stop if either lock is busy.

In the root-private state and run directories, match the marker's sole
`restore_id` to the selected completed source pair. Confirm
`runs/<restore-id>/pause.json` records a successful pause alongside
`prior.json`, with no `resume.json`. The active marker and any archived
copy must be regular root:root mode-0600 files.

- With only the active marker present, create a hard link named
  `inherited-production-maintenance.json` in the source run directory.
  The link must fail if that path already exists.
- With both names present, require the two paths to identify the same
  inode on the same device. Sync the run directory before unlinking the
  active name, then sync `/var/lib/keep-backup`.
- With only the archive present, verify its sole `restore_id` matches the
  selected source pair and sync `/var/lib/keep-backup`.

Stop on any other state, including a missing marker and archive, an
unexpected active marker, or an archive with a different inode. Record
the source restore ID and archived marker path alongside the promotion ledger.

### Audit the coordinated Atlas recovery point before failback

Hold Atlas write ingress, direct database writes and restart or deploy
automation. Record the UTC freeze time before dispatch. The Atlas
coordinator drains the admitted guest services and leaves them paused
through publication, failure, recovery and abort. PostgreSQL stays up
for the dump. Keep the external write freeze in place until failback.

Use a root-owned mode-0600 JSON policy reviewed separately for the
active Atlas pair. Record its SHA-256 before dispatch. It contains the
absolute `ledger` path and independently recorded `ledger_sha256`,
`frozen_at`, approved `vm_storage`, `mount`, `luks_uuid` and
`reserve_gib`. Under `pbs`, pin the `backup` alias's `server`,
`datastore` (`main`), `namespace` (null if absent), `username`,
TLS `fingerprint` and `encryption-key` fingerprint. The
`offsite_repositories` map pins the `records` and `originals`
repository IDs. Set `vault_hostname` to the promoted Atlas Vault's
distinct Tailscale FQDN, without scheme, port or trailing dot. Stage the
independently approved Keep Vault origin on the Atlas coordinator using the
same root-owned identity file format as the Keep backup guest. The capture
preflight rejects a missing private identity or an Atlas hostname that matches
the staged Keep hostname. [Vault identity staging](infra/keep-storage/deployment.md)

Before dispatch, qualify both promoted guests for capture:

- Install the reviewed `backup_guest.py` and `backup_inventory.py` together
  under `/usr/local/lib/keep-backup/` on each guest. Verify QEMU guest-agent
  execution. The first Linux hostname labels must be `quantself` and
  `files`, respectively. The Vault's Tailscale node name can differ.
- Stage the matching production backup profile, image archive and drain proof
  on `quantself`. For a PBS clone, verify the [inherited maintenance marker
  was reconciled](#reconcile-the-inherited-pbs-maintenance-marker-before-atlas-promotion).
  On `files`, restage the reviewed gateway proof at
  `/etc/keep-backup/vault-gateway.json` (root-owned mode 0600). Match Vault's
  `OC_URL` and the app's Vault URL to the pinned Atlas hostname. Its only
  Serve route must be HTTPS 443 to `http://127.0.0.1:9201` through the
  reviewed Caddyfile. The B2 application trees omit the installed guest
  helpers and the Vault gateway proof.
- Verify capture authorization for the pinned PBS `backup` alias and
  scoped upload access to both pinned B2 repositories. The temporary PBS
  restore alias and the disconnected local-restic rehearsal cover recovery
  only. Keep schedules and inherited Keep identities disabled on Atlas.

```sh
python3 -B scripts/infra/keep-storage/atlas_failback_capture.py run \
  --policy "$private_atlas_capture_policy" --policy-sha256 "$recorded_atlas_policy_sha256"
```

On interruption, use `recover` with the same policy and digest to observe
the original operations. `abort` settles the original operations and
keeps writers paused. Preserve the active record under
`/var/lib/atlas-failback` for reconciliation. Resume or restart requires a
separately scoped operator action. After publication, record the SHA-256
of `runs/<restore-id>/complete.json` in the trusted failback record:

```sh
sha256sum < "$atlas_complete_manifest"
```

On the isolated recovery target, use the original Atlas promotion ledger,
the SHA-256 recorded at promotion, and the exact captured manifest and trees:

```sh
python3 -B scripts/infra/keep-storage/audit_restore_pair.py "$atlas_complete_manifest" \
  --files "$restored_originals_tree" --quantself "$restored_records_tree" \
  --atlas-ledger "$private_atlas_promotion_ledger" \
  --atlas-ledger-sha256 "$recorded_atlas_ledger_sha256" \
  --atlas-frozen-at "$atlas_write_freeze_utc" \
  --atlas-complete-sha256 "$recorded_atlas_complete_sha256"
```

Require `atlas_failback_pair_verified` and the recorded restore ID. The
audit binds the archive groups to the promoted VM IDs, checks that both
snapshots fall inside the coordinated run after the freeze, and verifies
both extracted inventories. Format 1 records VM IDs. Independently
confirm the source host and clone UUIDs at capture time, then verify
Keep application catch-up and the Atlas writer fence before reopening
writes.

### Verify the Keep writer fence

When using a powered-off guest fence and the Keep hypervisor is reachable,
pause deploys and reconcile any active host operations in the scoped
window. After the operator applies the fence, run as root on Keep:

```sh
python3 -B scripts/infra/keep-storage/verify_keep_writer_fence.py
```

Require `keep_guests_fenced` for Quantself 2541 and Vault 2540. With
both guests stopped, API, workers, PostgreSQL and OpenCloud on those guests
cannot receive or initiate writes. The verifier checks for HA, start on host boot,
autostart, pending config changes and locks before reading power state.
Keep the fence in place while Atlas is the writer. If Keep is unreachable,
require independent evidence that it is fenced before enabling Atlas writes.

Verify public routing separately on Gate using `tailscale funnel status --json`
and the [deployed relay paths](../deploy/gateway/README.md#hostinger-independent-rehearsal).
If holding both relays offline, check that
`ss -H -ltn '( sport = :8780 or sport = :8790 )'` returns no listeners.
Before reopening delivery, verify the effective Funnel origin and any enabled
legacy relay target Atlas only. Check provider destinations and private
dashboard routing against the same cutover record.

### Verify the Atlas writer fence before returning to Keep

When Atlas opens writes, record which Atlas restore ledger identifies the
active records and originals guests. Keep that ledger with the promotion
record. After cross-checking both roles against the active writer pair,
capture the ledger's SHA-256:

```sh
sha256sum < "$private_atlas_promotion_ledger"
```

Save the 64-character digest separately in the trusted promotion record
for this activation. For failback, use that recorded digest and the
original ledger bytes. Run only on the independently verified Atlas host
under the scoped access procedure. The digest pins the selected ledger.
Keep the host and active promotion record checks in place.

After stopping both Atlas writers and applying the powered-off fence
within the scoped window, run as root on Atlas:

```sh
python3 -B scripts/infra/keep-storage/verify_keep_writer_fence.py \
  --atlas-ledger "$private_atlas_promotion_ledger" \
  --atlas-ledger-sha256 "$recorded_atlas_ledger_sha256"
```

Require `atlas_guests_fenced` for both promoted VM IDs. The helper checks
both recorded UUIDs, HA status, startup policy and locks before reading
power state. A stopped replacement with a reused VM ID and different
UUIDs fails. Treat the result as a point-in-time observation. Keep the
same operator in control of both guests and pause automation that could
start them. Repeat the check if the fence or configuration changes.
Before changing public delivery or reopening writes, independently verify
the coordinated Atlas recovery point, catch-up on Keep, and the effective
Gate and private dashboard destinations.

## Acceptance record

Record UTC time, environment, revision, restore-point ID, timings and evidence for each row. All production rows remain pending until live execution.

| Check | Required observation |
| --- | --- |
| Identity and access | Approved Mac and iPhone automatically reach the existing Owner account at `qs.girke.dev` over trusted TLS. Public and unauthorized LAN/tailnet clients are denied; spoofed headers do not authenticate. Perform real scoped Agent actions and live signed callbacks before retiring browser passkeys. |
| Originals | Upload/open a receipt; test Owner-only denial. Upload and play/seek To-Do and Inventory audio, including legacy-converted recordings. Check full/range hashes, 206/416, image and attachment access, same-space stable IDs, and missing/orphan counts. |
| WebDAV and app latency | Record cold and warm upload/open/seek latency, bytes and upstream requests. Confirm one conditional upstream GET per media read/seek and zero WebDAV requests for metadata lists/transcripts. Record task-detail request counts after authentication with pagination exceptions if exercised. |
| Inventory workers and Codex | Preserved login passes status in the worker. Staged job claims, private API access, retries and resulting metadata work. Worker credentials and Vault identity boundaries hold. Confirm added writers and state are covered by backup quiescence. |
| Jarvis and Push | Owner approves real Twilio/ElevenLabs checks. Verify web Jarvis and authorized call/PIN/tool callbacks. Register Web Push in the Owner’s browser at the new origin, then verify one approved delivery. Existing dashboard subscriptions belong to the old origin. Verify prohibited callback requests fail and old endpoints are disabled or controlled. |
| Analytics and portfolio | Run one authorized collector event, verify read-only private reporting, verify registered redirect behavior, and check baseline mail flow, portfolio and DNS records after changes. |
| Edge | From an external source test permitted exact webhook methods/paths with scoped authorization, rejected paths and methods with 404, and direct-origin/LAN denial. Check receiver idempotency across retries. |
| Deployment | Stage the verified image archive and its matching drain proof. Observe one real GitHub Actions deploy from ephemeral CI over strict SSH, the same image healthy over private HTTPS, logs following, and public SSH and Vault access denied. Recheck backup compatibility after deploy. |
| Recovery and rollback | Complete paired production capture, isolated restore of database and file originals with application checks, exact IDs/hashes/refs, and a verified fallback path. Record backup/drill schedules and alert status. Record the Atlas drill separately when the Owner schedules it. |

Close #209 only after the live evidence is recorded, then update #208 and hand off #226. Keep private names, secrets, raw logs and individual original hashes out of public evidence.
