# OpenCloud originals: Session 1 handoff

Implementation for [#253](https://github.com/devdogfish/quantself/issues/253); accepted design and ADR 0048 are preserved in [#252](https://github.com/devdogfish/quantself/issues/252). This contract is for #254 (private storage infrastructure) and #209 (deployment/cutover). No production data conversion or infrastructure changes are performed by this change.

## Runtime contract

Apply PostgreSQL migrations with `bun run --cwd packages/db migrate:deploy-only` **before** starting this version of the API. Migration `20261114010000_original_files` is additive: it creates the durable file/attempt ledger and nullable `BudgetReceipt.originalKey`; it does not convert data. PostgreSQL remains Docker-only. Generate the Prisma client when building.

Only the API process needs these settings. `compose.yaml` forwards them only to `api`:

| Setting | Default / meaning |
| --- | --- |
| `QUANTSELF_ORIGINALS_PROVIDER` | `legacy`. Explicit `opencloud` selects OpenCloud for new originals; other values fail closed. |
| `QUANTSELF_OPENCLOUD_URL` | Required HTTPS origin, e.g. `https://vault.internal.example`. Verified TLS; no credentials, path, query or fragment. |
| `QUANTSELF_OPENCLOUD_SPACE_ID` | Full OpenCloud drive/space identity, including storage prefix; use the ID from LibreGraph. |
| `QUANTSELF_OPENCLOUD_USERNAME` | Dedicated non-admin application identity. |
| `QUANTSELF_OPENCLOUD_TOKEN` | Supported app token for that identity, provided as a server secret. Never a browser/Agent setting. |
| `QUANTSELF_ORIGINALS_WRITE_PAUSED` | `0`; `1` rejects receipt/media upload/delete and reconciliation while reads remain available. |

Existing `DATABASE_URL`, `QUANTSELF_TODO_CAPTURE_ROOT`, `INVENTORY_UPLOAD_DIR`, `INVENTORY_AUDIO_UPLOAD_DIR`, and `INVENTORY_ASSET_UPLOAD_DIR` remain necessary for legacy originals and rollback. Legacy remains the default on Hostinger. Selecting OpenCloud does **not** migrate existing bytes; selecting legacy does **not** make existing OpenCloud references local. Retain OpenCloud settings until every remote reference has been rolled back and every queued deletion reconciled.

Compatibility verified with OpenCloud **7.2.0**, PosixFS, Docker PostgreSQL **18**, supported app-token Basic authentication, account-password Basic authentication disabled. Pin/verify upgrades against the included integration harness. TLS verification is disabled only in the isolated localhost test process, never by application code or compose runtime settings.

Create one restricted Quantself originals space. App identity: Editor there, no personal-documents access, no admin role. Owner identity: Viewer there. Changes through Quantself; administrative recovery is separate. Folder creation uses `Receipts`, `Recordings`, `Inventory`, `Pending`. Original names include an immutable key suffix. File IDs are scoped to the configured space, not assumed portable across spaces. Renames within a space remain readable by stable ID; path hints may become stale.

Clients get existing authorized Quantself URLs, never redirects or Vault credentials. Receipt originals remain Owner-only. Inventory preprocessing workers use `INVENTORY_PREPROCESSING_WORKER_BASE_URL` and `INVENTORY_PREPROCESSING_WORKER_SECRET` to read originals through the new restricted internal inventory endpoint. Enrichment continues through its existing authorized image endpoint. Do not put OpenCloud credentials in either worker.

## Durability and failures

`OriginalFile` persists provider, space/file identity, path hint, MIME, bytes, SHA-256, ETag, timestamps and `pending → ready → deleting → deleted` state. Owning rows retain opaque `original:` references (receipt `originalKey`, inventory `filePath`, capture archive audio key). No permanent second original is exported.

Every upload reserves its immutable fingerprint before external work. Each attempt has its own durable `Pending/<uuid>` path. PUT never relies on `If-None-Match`. MOVE uses `Overwrite: F`; a final path is reconciled by stable identity, ETag and streamed SHA-256 verification before publishing `ready`. Cross-process PostgreSQL advisory locks serialize the same key; receipt content locks also deduplicate simultaneous requests with different IDs before uploading. A conditional publish cannot overwrite a concurrent deletion intent. A changed payload is a conflict. Same-key retries reuse the existing reference; ambiguous remote success and DB failures remain recoverable.

The external upload is intentionally not atomic with PostgreSQL. A failed caller can leave an unreferenced pending/ready ledger entry; retry the identical operation. Do not delete these entries automatically: a concurrent request or unknown commit may own them. Inspect/reconcile against owning records and backup evidence before manual retirement. No background directory crawls or arbitrary orphan deletion occur.

Inventory and receipt deletion queue the ledger state in the same database transaction that removes the owning record. Capture deletion persists a tombstone before removal. An API worker retries queued deletions every minute, at most 50 per tick. Files whose ETag changed are retained for investigation. Temporary cleanup only considers durable tracked attempts older than 24 hours, under the same per-key lock; it never deletes final originals. Deleted ledger tombstones are retained. Original files have no automatic expiry.

Per-file WebDAV operations time out after 120 seconds. Redirects are refused. The upload serialization transaction has a 10-minute ceiling; receipt content-deduplication and inventory upload command transactions use that same ceiling (existing legacy commands retain their timeout). OpenCloud receipt/inventory uploads have a shared per-process admission limit of three, acquired before domain transactions to avoid exhausting the DB pool with nested ledger work. Files in one request are processed sequentially; size/count limits remain bounded by existing routes. Avoid high upload concurrency on a small database pool; measure on Keep before capacity planning.

Missing files, unavailable credentials/network, full storage, pending uploads and conflicts have explicit recoverable errors. Metadata lists/search/transcripts require no WebDAV requests. Media reads issue one conditional GET by file ID, proxy `Range`/206/416, stream with backpressure and cancellation, and expose no credential. ETag checks protect the SHA-verified original without downloading an entire recording for each seek. Existing bounded multipart/raw uploads and preprocessing payloads still buffer received bytes (capture/media maximum 50 MiB per file; receipts 24 MiB); remote media responses and verification stream. This is not an unlimited upload API.

## Conversion / rollback

Never run conversion against production as part of Session 1. Session 3 must schedule write downtime and make verified DB + OpenCloud backups first. Explicitly select the intended Docker PostgreSQL URL and the required legacy volume paths; do not inherit a development URL accidentally.

Commands run from the repository root, using Bun:

```sh
# Read-only, paginated DB inventory, per-category counts and byte totals; no WebDAV calls.
bun scripts/originals/convert.ts inventory > inventory.jsonl

# Stop API and workers first. CLI is the sole writer.
# DATABASE_URL, legacy roots and OpenCloud settings must point at the intended environment.
export QUANTSELF_STORAGE_MAINTENANCE=1
export QUANTSELF_ORIGINALS_WRITE_PAUSED=0
bun scripts/originals/convert.ts convert /secure/restore-point/mapping.jsonl
bun scripts/originals/convert.ts resume /secure/restore-point/mapping.jsonl

# Restore original source mappings; receipt bytes rehydrate from verified OpenCloud originals.
# Legacy filesystem files must still exist and match recorded checksums.
bun scripts/originals/convert.ts rollback /secure/restore-point/mapping.jsonl

# Retry queued deletes / retained temporary attempts; does not erase unbound final originals.
bun scripts/originals/convert.ts reconcile
```

Manifest contains IDs, source locations, destinations, byte counts and SHA-256, with durable `prepared` before reference changes and `converted` afterward. It contains no credential or original payload. Protect it as sensitive metadata (created mode 0600). Re-running conversion inventories only remaining legacy records; `resume` verifies/reapplies prepared mappings; repeated resume/rollback is idempotent and refuses changed sources. Categories: PostgreSQL receipt bytes, capture audio, inventory images, inventory audio, inventory assets. Capture JSON fingerprints change with the persisted key so identical audio retries still work after conversion.

Receipt conversion removes inline bytes after the verified reference is available. Filesystem legacy originals remain as temporary rollback sources; retire them only after reference counts, checksums and coordinated backups/restores have been verified in Session 3. This tool never deletes legacy filesystem originals. Keep the pre-conversion DB backup until rollback is no longer needed. Code rollback requires mapping rollback first; old code cannot interpret `original:` paths.

## Backup / write pause

1. Stop new upload/delete requests; set `QUANTSELF_ORIGINALS_WRITE_PAUSED=1` on **every** API instance and restart/drain them. The setting is process-local, not a distributed lock.
2. Stop API/processing/conversion workers after in-flight requests drain. Merely changing an environment variable does not cancel existing uploads. Pending ledger rows may represent earlier failed attempts; include them in the snapshot.
3. Reconcile known pending operations before the maintenance window where practical. Under the pause, record counts by ledger state, record references, and a restore-point identifier.
4. Take a Docker PostgreSQL dump and an OpenCloud-consistent backup under the same pause, preserving configuration, system metadata, PosixFS xattrs and bytes. Follow OpenCloud's stop/snapshot/restart requirements; a database-only dump is insufficient.
5. Session 2 owns encryption, capacity, token rotation, schedules and isolated restore verification. Verify hashes/references/permissions/playback before resuming all writers. Backups and manifest share the restore-point ID.

Environment changes, TLS/network reachability, host provisioning, SSH, gateway, DNS, production conversion and cutover remain with #254/#209. Schema first, code second, credentials/provider opt-in third, migration last under the scheduled pause.

## Verification

Run `scripts/integration/opencloud/run.sh`. It creates fresh isolated Docker volumes and scoped synthetic identities, deploys the **actual application migrations**, and exercises actual receipt, capture and inventory routes against OpenCloud. It renders the unmodified receipt library/detail pages and AudioPlayer in Chromium with synthetic routing/auth context. It does not run the deployed Next.js/auth session stack; existing authorization checks execute inside the actual route handlers.

The harness requires Docker, Bun, Node, ffmpeg, curl and Chromium installation support. It binds localhost OpenCloud port 19200 and browser fixture port 19301; PostgreSQL gets a random loopback port. It never connects to a production database. Containers/volumes are deleted on exit; output directory includes synthetic credentials, JSON measurements, mapping manifest and UI screenshots, so keep that directory private. The earlier #252 proof artifacts remain unchanged.

See [Session 1 validation](validation/2026-11-13-opencloud-integration.md) for measured request counts/timings and remaining environment-specific limits.
