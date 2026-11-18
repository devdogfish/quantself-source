# Quantself import and résumé handoff

Use a dedicated Quantself API key with only `jobs:import-tailored`. Configure it as an n8n Header Auth credential with header name `X-API-Key`. Configure the Quantself base URL for the n8n instance. The sole Quantself request is `POST /api/v1/jobs/applications/import`.

1. Pass kept candidate objects to `prepareQuantselfBatches(candidates, runId)`. Use a workflow- and execution-specific run identifier. The function deduplicates by `sourceIdentity` before forming requests and maps Excel to Quantself's Admin and Excel résumé variant. It prepends the fit note to the posting description shown in Jobs.
2. Send one JSON request per batch. Use the batch's `idempotencyKey` as the `Idempotency-Key` header and `body` as the JSON body. Disable redirects and use a bounded timeout. Keep status and response body paired to the batch. There are no Quantself reads. Batches contain at most 100 rows and are bounded below the API's 1,500,000-byte limit.
3. Retry uncertain transport failures, server errors and transient write conflicts once with the same key and exact body. Rate limits stay visible for a later run. A fresh scheduled execution uses a fresh run identifier. The API replays a saved response for the same key and payload. It skips previously stored Greenhouse postings by their public board and posting ID across executions. Other rows use their canonical source URL. Keep the original request available until an uncertain import has been reconciled.
4. Pass the batches and the corresponding full `{ statusCode, body }` results to `summarizeQuantselfImports`. A failed or missing response occupies that batch's slot. Report failures alongside confirmed counts. No requests are needed when there are zero batches.

The strict import contract accepts posting metadata and returns `{ imported, duplicates }`. The feed grant creates drafts using configured résumé templates. It cannot read or edit applications, record historical outcomes, supply résumé templates, or access the private worker routes. The response contains no application IDs. The existing source identity is unique within a Quantself owner account. Cross-board aliases deduplicate when Quantself derives the same posting identity from their URLs. Distinct canonical identities remain distinct.

## Full résumé tailoring requires the Owner

After a confirmed import, enrichment and tailoring run in the private Codex worker. Find the applications under **Jobs → Applications**. The API needs portable Markdown templates for the imported tracks. It returns exact counts, and the batch summary includes candidate names and URLs.

The import queues one enrichment job for each new draft. The current worker uses approved candidate context, enriches the posting and prepares a Summary for review. The worker uses the exact public We Work Remotely RSS entry for that source and strips contacts. If the entry is absent, it uses the role title and approved candidate facts. Full résumé review and approval stay with the Owner.

The API can bind a Greenhouse identity to an existing row whose canonical URL matches the import or whose hosted Greenhouse path matches the board and posting ID. A conflict between two existing rows requires reconciliation. A custom URL that changed before the first binding can still produce a duplicate. Apply the API migration before using the updated export.

The [import contract](../../../../apps/api/src/jobs-owner-contract.ts) and [provider binding](../../../../apps/api/src/jobs-provider-import.ts) define these rules.

Run the offline fixtures with `bun test --isolate automation/n8n/jobs-feed/quantself/quantself.test.mjs`.
