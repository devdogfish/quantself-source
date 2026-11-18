# Portfolio ingest for #301

Server-side `POST /api/v1/website-analytics/events` accepts JSON with 1–50 events in at most 32 KiB. Send the dedicated ingest key in `X-API-Key`. A 202 returns `{ "received": 1, "inserted": 1 }`. Keep each UUID on retry. A replay returns 202 with `inserted: 0` and leaves the stored event intact.

```json
{
  "events": [
    {
      "id": "10000000-0000-4000-8000-000000000001",
      "occurred_at": "2026-11-14T18:00:00Z",
      "kind": "page:view",
      "visitor_id": "10000000-0000-4000-8000-000000000002",
      "session_id": "10000000-0000-4000-8000-000000000003",
      "page_view_id": "10000000-0000-4000-8000-000000000004",
      "path": "/projects/rbc",
      "link_code": "k3Vw9QpX",
      "utm_source": "linkedin",
      "device": "mobile",
      "props": {}
    },
    {
      "id": "10000000-0000-4000-8000-000000000005",
      "occurred_at": "2026-11-14T17:59:59Z",
      "kind": "link:open",
      "path": "/r/k3Vw9QpX/rbc",
      "link_code": "k3Vw9QpX",
      "ip_id": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "props": { "method": "HEAD", "key": "rbc", "ua": "Synthetic browser" }
    }
  ]
}
```

Map portfolio `via` and redirect route `code` to `link_code`. Send syntactically valid codes even if lookup was unavailable. Ingest saves the code without a registry lookup. Send the pathname without query or fragment. Send only a hostname in `referrer_host`, and send the full lowercase hex daily HMAC in `ip_id`. The optional attribution fields are `link_code`, `utm_source`, `utm_medium`, `utm_campaign`, `referrer_host`, `device` (`desktop` or `mobile`) and `ip_id`.

The four browser events require `session_id` and `page_view_id`. `visitor_id` is optional for every event. The redirect and form events may omit all three. `received_at` is assigned by Quantself.

| `kind` | `props` |
| --- | --- |
| `page:view` | Optional `isRestore` boolean |
| `page:engagement` | `activeMs` integer, `maxScroll` percentage from 0 to 100 |
| `cta:click` | `cta` and optional `target`, both stable labels |
| `outbound:click` | `target`, a stable label or hostname |
| `link:open` | `method` (`GET` or `HEAD`), optional destination `key` and `ua` (up to 512 characters). `link_code` is required. |
| `contact_form:submit` | Optional `method` (`form`) and `result` (`ok`, `validation_error` or `server_error`) |

Send form content separately to `POST /api/v1/website-analytics/inquiries`. Use the same ingest key and JSON with `id` (UUID kept on retry), `name`, `email`, `topic`, `message` and optional `link_code` from `via`. It returns 202 with the inquiry `id`. Analytics events carry only the form outcome. The Owner can change inquiry status through `PATCH /api/v1/website-analytics/inquiries/{id}`.

The [Zod contract](../apps/api/src/website-event-contract.ts) defines field validation. Both tables are in the primary Quantself Postgres database and included in its full database backups.

The API reads `QUANTSELF_WEBSITE_ANALYTICS_INGEST_TOKEN`. Gate sends the two ingest POSTs and the tracked-link lookup GET to Keep. Keep uses Quantself PostgreSQL for analytics. The standalone Umami collector is available for Hostinger rollback and stages separately from the repository with `scripts/website-analytics/stage-live.sh`.

## Historical import

The final frozen source remains sealed for rollback. The import verified all 208 distinct IDs from 273 eligible records, with zero rejects and zero inserts on replay. For a reimport rehearsal, restore the approved dump to an isolated Umami database, use the dedicated read-only role, and point the importer at a disposable Quantself database with the #301 migration applied. [Final import evidence](https://github.com/devdogfish/quantself/issues/301#issuecomment-6897108922)

With the source reader, website ID and destination database configured, run `bun apps/api/scripts/import-website-events.ts --dry-run` to count retained portfolio rows and rejects. Use `--apply` for an authorized reimport. Replays skip UUIDs already imported. Record the result and reconcile eligible UUIDs and any rejects with the destination.

#289 should use the imported `props.source` when attribution is absent from the UTM columns. Only UTMs present in Umami populate those columns. Imported scroll events retain `props.maxScroll`, and existing résumé opens keep their original path, code and destination context. Imported booking completions carry `kind: "cta:click"` and `props.method: "booking"`; imported form completions carry `kind: "contact_form:submit"`.

The API runs daily cleanup that clears `visitor_id` on events strictly older than 13 UTC calendar months. It keeps the events and leaves inquiries subject to their own lifecycle.
