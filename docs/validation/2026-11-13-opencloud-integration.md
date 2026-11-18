# OpenCloud application integration validation — 2026-11-13

Issue #253, Session 1. Real OpenCloud 7.2.0 PosixFS + fresh Docker PostgreSQL 18; actual Quantself schema/migrations and route handlers. All content synthetic; Hostinger untouched. Earlier #252 proof artifacts preserved.

## Result

13 application integration groups passed, plus 4 bootstrap/authentication checks. Unmodified ReceiptLibraryPage, ReceiptDetailPage and AudioPlayer exercised in Chromium with synthetic router/Access Context; application authorization checks run inside the actual route handlers. This verifies actual application components and APIs, not the deployed Next.js authentication stack.

- Actual receipt upload/open/list; original bytes absent from PostgreSQL; Owner-only authorization.
- Concurrent receipt retries deduplicate even across different IDs; changed-payload replay rejected.
- Actual capture recording upload/seek, denied access, invalid range and database-only transcript.
- Actual route recovers ambiguous MOVE using durable pending record and verified hash.
- Actual receipt route recovers DB attachment failure without uploading another original.
- Database failure after remote success and independent concurrent attempts recover without overwrite.
- Deferred upload cannot overwrite a later durable deletion intent.
- Actual routes preserve metadata and report revoked credential, full storage, timeout and missing originals.
- Actual inventory multipart upload and reads cover image/audio/asset; lists make zero WebDAV requests.
- Preprocessing API reads only attached inventory; receipt references and unauthenticated workers denied.
- Dry-run inventory, all five conversion categories, manifest restart and checksum-verified rollback.
- Actual receipt library/detail UI upload/open; actual AudioPlayer playback and seeking in Chromium.
- Write pause preserves reads; durable inventory delete retries outages; capture deletion revokes reads.

The read-only conversion inventory also walked 210 records across multiple pages without any WebDAV request; a second pass changed eligibility for 205 rows while iterating and confirmed none were skipped at page boundaries. Rehearsal converted all five legacy categories and replayed the write-ahead manifest, then restored legacy mappings/receipt bytes with checksum validation. Capture upload retries still matched their idempotency fingerprints after conversion.

Real faults: removed OpenCloud file, lost MOVE response after actual success, database transaction/receipt attachment failures, competing writes, changed bytes, deferred upload versus deletion. Controlled transport faults: revoked-auth status, storage-full 507 and network timeout injected at the adapter boundary and exercised through actual routes. A separate adapter test verifies AbortSignal timeout. No real disk was filled.

## Measurements

Local Mac Docker, one synthetic run with Bun 1.3.14; not Keep capacity or production latency claims. Payload is the requested original/range, not JSON metadata response size. Download includes verification bytes and WebDAV XML/error bodies when Content-Length is present; transfer framing is excluded.

| Operation | Wall ms | WebDAV requests | Original/range bytes | Uploaded bytes | Downloaded bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| receipt upload cold | 374 | 7 | 248 | 248 | 1,048 |
| receipt open warm | 28 | 1 | 248 | 0 | 248 |
| receipt list | 3 | 0 | 0 | 0 | 0 |
| recording upload cold | 857 | 7 | 34,560,078 | 34,560,078 | 34,561,166 |
| recording range warm | 36 | 1 | 1,000 | 0 | 1,000 |
| recording open warm | 206 | 1 | 34,560,078 | 0 | 34,560,078 |
| capture transcript | 6 | 0 | 0 | 0 | 0 |
| inventory list | 5 | 0 | 0 | 0 | 0 |

Cold means first upload into that collection (directory setup included); the recording upload reused an established OpenCloud connection and existing Pending directory. Warm opens happen after setup. Recording: 180 seconds, 48 kHz stereo PCM WAV, 34,560,078 bytes. Receipt: synthetic 64×96 PNG, 248 bytes. Seven upload requests: final-path probe, two MKCOLs, staging PUT, non-overwriting MOVE, identity PROPFIND, streamed hash verification. Warm full/range reads use one conditional GET; list/transcript reads use zero WebDAV requests. API-owned row checks remain PostgreSQL reads.

Responses/verification stream without recording-sized buffering. Existing upload size limits/buffering remain, including 50 MiB capture/media and 24 MiB receipt limits. Image preview derivation is bounded by existing upload limits. Upload transactions serialize one key and permit later delete intent to win; bulk Item deletion queues references in one DB write and limits file cleanup concurrency to four.

## Reproduce and handoff

Run `scripts/integration/opencloud/run.sh`; it creates and destroys isolated Docker volumes and emits JSON, manifest and UI screenshots in a private temporary directory. The test-only TLS bypass is confined to localhost. See [runtime and conversion contract](../opencloud-originals.md) for exact settings, credential boundaries, migration ordering, pause hooks and rollback commands.

Session 2 must verify private TLS/networking, capacity, credential lifecycle, coordinated encrypted backup and isolated restore on Keep. Session 3 owns production migration and cutover. No production conversion/deployment is included here.

## Repository checks

Final isolated checkout: `bun run typecheck` passed; `bun run test` retained `--isolate` and passed **1,741 tests**, with **12 skipped**, **0 failures** across 378 files. Seven adapter/admission tests cover immutable uploads, request counts, identity/ETag conflicts, missing/full/unavailable storage, timeout, safe paths and bounded upload concurrency. An earlier suite run hit the existing calendar scroll timing test; it passed both its focused rerun and the final complete run. That test was not changed.
