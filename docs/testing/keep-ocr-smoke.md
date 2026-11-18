# Keep receipt OCR smoke for #155

[#493](https://github.com/devdogfish/quantself/pull/493) passed capture, queued local OCR, concealed detail, explicit reveal, scoped denial, byte-exact download, deduplication and cleanup on disposable OpenCloud and legacy stores. Use this smoke to verify the active Keep queue. Report fields for AI clients stay under the separate Owner decision in [#155](https://github.com/devdogfish/quantself/issues/155).

## Scope and preflight

Use the Owner’s existing Brave profile at `https://qs.girke.dev/budgeting/receipts`. Before running, obtain a named #217 window for the serving API on Keep VM 2541, one synthetic receipt, one identical replay and permanent deletion of that exact synthetic receipt. Include the optional read-only ledger check if the operator already has database access. Avoid a deploy or backup window. Use [#217](https://github.com/devdogfish/quantself/issues/217) and the [infrastructure session workflow](../agents/infrastructure-sessions.md).

Set `KEEP_API_CONTAINER` to the serving API container identified by the current deployment. Leave `KEEP_OCR_CONTAINER` unset for the combined API. For a split deployment, set it to the active worker container.

```sh
(
set -eu
docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "${KEEP_API_CONTAINER:?Set the active Keep API container}"
docker exec "$KEEP_API_CONTAINER" sh -ec '
  test "${QUANTSELF_ORIGINALS_PROVIDER-}" = opencloud
  test "${QUANTSELF_ORIGINALS_WRITE_PAUSED-0}" = 0
'
docker inspect --format '{{.Image}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "${KEEP_OCR_CONTAINER:-$KEEP_API_CONTAINER}"
docker exec "${KEEP_OCR_CONTAINER:-$KEEP_API_CONTAINER}" sh -ec '
  case "${QUANTSELF_API_MODE-combined}" in combined|workers) ;; *) exit 1;; esac
  test -z "${GIRKE_API_BASE_URL-}${GIRKE_API_TOKEN-}"
  test "${QUANTSELF_ORIGINALS_PROVIDER-}" = opencloud
  test "${QUANTSELF_ORIGINALS_WRITE_PAUSED-0}" = 0
  command -v pdfinfo >/dev/null
  command -v pdftotext >/dev/null
  command -v pdftoppm >/dev/null
  tesseract --list-langs | grep -qx eng
  echo local_ocr_opencloud_ready
'
)
```

Require both checks to succeed and expect `local_ocr_opencloud_ready` before upload. Record the image IDs and source revisions. The **OCR completed** label requires the deployed app and API to include [#457](https://github.com/devdogfish/quantself/pull/457) and its migration. An older release can archive a receipt after OCR without recording provenance. If the installed revision predates #457, record that limit and keep the UI provenance criterion open. Stop if the active image changes or configuration disagrees.

## Owner browser steps

1. Use [keep-ocr-smoke.pdf](fixtures/keep-ocr-smoke.pdf). Its SHA-256 is `0d46f4e9c181263a3947d147898bb1891d525c242e41dcb377aae72996d03b24`. It contains a fictional merchant with no date or total. The worker calls bank reconciliation only when OCR returns a total.
2. In Brave DevTools **Network**, filter to `/api/v1/budgeting/receipts`. Select **Receipt**, leave **Archive originals only — no OCR** unchecked, and choose that single PDF in **Upload documents**. Read the synthetic upload POST’s status, request `id` and response `id`. Expect HTTP 200, matching IDs and `scanStatus: pending`. Keep the exact ID for follow-up. If the reply is lost, check the request’s exact ID before another upload. A different response ID is a pre-existing digest match. Stop and leave that record alone.
3. Open `https://qs.girke.dev/budgeting/receipts/<id>` for that ID. Before reveal, expect **Document content is hidden**. Wait for **OCR completed** on the normal polling path. Record upload-to-completion time. If it fails or stalls for a minute, record the last status and keep the row for diagnosis inside the approved window. The manual scan button would test a different path.
4. Click **Reveal document** on that detail only. Expect **Fictional Orchid OCR Canary**, date and total empty, and no linked expense. Click **Download original PDF** and compare its SHA-256 with step 1 using `shasum -a 256`. Upload the same file once more from the library. The replay must return the same ID. If a different ID appears, record both IDs and stop for reconciliation.
5. If the named window includes the optional ledger check below, bind the original before deleting. Reopen the exact ID and reveal it. Verify the canary merchant, empty total and no linked expense. Click **Delete**, then **Delete permanently** in **Delete this document?**. Reopen the same detail and verify `GET /api/v1/budgeting/receipts/<id>` and `GET /api/v1/budgeting/receipts/<id>/original` return 404. The normal delete queues storage cleanup. The 404s verify application-level removal. If a ledger check is in scope, confirm its terminal state below. Remove the local downloaded copy.

Record the image IDs, synthetic receipt ID and digest, request counts, timings, capture and OCR statuses, replay ID, hash match and deletion result. Keep the pre-existing scoped denial and OpenCloud deletion-worker evidence from #493. The live browser smoke needs only the Owner session. Report storage cleanup as unverified when the optional ledger check is out of scope or fails to reach the terminal state.

## Optional OpenCloud cleanup check

Reuse the approved local PostgreSQL shell on Keep VM 2541. Confirm the `quantself-postgres` container is the active database using `docker compose ps` and `docker ps`. Use the existing [operator connection](../home-production-timing.md#same-database-rollback-evidence). If that access is outside the window or authentication fails, use the browser evidence only.

```sh
docker exec -it quantself-postgres sh -ec '
  exec psql -XqAt --no-password -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
'
```

Before browser deletion, paste this into the operator’s `psql` session. Replace `<id>` with the matching upload UUID. The exact key stays in the session. If the lookup cannot bind one row, skip the ledger check.

```sql
\set receipt_id '<id>'
\set canary_sha '0d46f4e9c181263a3947d147898bb1891d525c242e41dcb377aae72996d03b24'
\unset canary_key
BEGIN READ ONLY;
SELECT o.key AS canary_key
FROM auth_owner AS a
JOIN budget_receipt AS r ON r."ownerId" = a."userId" AND r.id = :'receipt_id'
JOIN original_file AS o ON r."originalKey" LIKE 'original:%'
  AND o.key = substr(r."originalKey", length('original:') + 1)
WHERE a.id = 'singleton' AND r."imageHash" = :'canary_sha'
  AND o.sha256 = :'canary_sha' AND o.provider = 'opencloud' AND o.state = 'ready'
\gset
ROLLBACK;
```

After browser deletion, use the same session. If the state is `deleting`, wait for the normal worker and query again. Record `deleted` only when returned. No row is inconclusive.

```sql
BEGIN READ ONLY;
SELECT state FROM original_file
WHERE key = :'canary_key' AND sha256 = :'canary_sha' AND provider = 'opencloud';
ROLLBACK;
```

The ledger reaches `deleted` after the provider removal call succeeds or the worker finds the target absent. That confirms terminal application cleanup. Independent inspection of the OpenCloud object, trash or backup copies is outside this smoke.

The canary was generated with #493’s image-only PDF fixture construction and fictional merchant-only content. Offline `pdftotext` produced no text. The real extractor using local Poppler and Tesseract returned the exact merchant and null date and total in 7.98 seconds on the Mac. This is fixture verification. Keep execution remains pending.
