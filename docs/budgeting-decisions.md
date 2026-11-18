# Quantself Budgeting decisions

## Purpose

Budgeting answers how long available cash will last and what the Owner can spend on Food and Other. It shows the first projected shortfall, upcoming bills, weekly spending, and what-if scenarios. Tax evidence is a second purpose. The Owner should be able to find originals and associated payments without searching folders.

The editable Budget Note uses a Lexical visual editor with Markdown and preview tabs. The Owner can use an existing Codex session to propose explicit plan edits and apply them from Budgeting. A cash checkpoint can be reset whenever needed. Historical spending remains available after a reset. A matching payment replaces its planned bill occurrence. Calendar integration is deferred.

## Transactions and documents

- Import posted CSV exports using stable account identities, including for legacy slots. Select the date, amount or debit and credit, description, and optional bank transaction ID columns locally. Identify transfers separately from expenses. Refunds reduce spending when classified as refunds. Deposits are retained. Forecast income comes from the plan until deposit reconciliation is added.
- Deduplicate by account and bank reference when supplied. The fallback uses date, description, amount, and the number of identical rows in the export. Without a bank reference, partially overlapping exports with indistinguishable charges can be ambiguous.
- Archive uploaded receipts immediately. An unmatched receipt contributes to spending only after the Owner explicitly records it as cash. Keep the bank transaction when its receipt is deleted.
- Run the same reconciliation after either import. An automatic link requires compatible merchants, equal amounts, dates within three days, and a unique candidate on both sides. Later imports can invalidate an automatic link. The Owner can optionally inspect amount-and-date candidates and link one explicitly. Amount alone does not establish a match.
- Keep one original receipt image or invoice PDF as evidence when useful, especially for tax claims. Structured fields support search, matching, and analytics. Keep the original alongside any deterministic reconstruction. Start with typed fields for document kind, issuer, date, currency, total, and optional tax year. The current receipt editor retains its structured printed lines. Add fields or line records when real examples establish a need.
- Invoices, credit notes, and tax slips can be archived independently of payment. One invoice may have several payments in the target design. The initial receipt matcher links one bank transaction and one receipt. PDF ingestion is supported. Invoice payment allocation is a follow-up.

## Import and privacy

Save originals before processing; no mandatory review or redaction. A durable, leased queue survives restarts and supports retry without losing files. Use self-hosted Girke OCR when configured (`GIRKE_API_BASE_URL`, `GIRKE_API_TOKEN`); otherwise use on-host Apple Vision/Tesseract. Never send document content to hosted models or Inventory’s Codex enrichment. PDFs use text extraction and OCR per page, up to eight pages; larger documents remain saved without partial extraction. Contracts, MSAs, and SOWs remain archive-only. Uncertain fields stay empty; posted bank rows drive spending.

Document content is hidden until explicit Owner reveal, with no preloading and no-store responses. Hiding clears revealed state and aborts pending reads. API-key/MCP callers cannot access document content, including through linked-expense mutations. Originals, OCR, and private fields must stay out of logs and analytics. Automated redaction and an AI reporting allowlist remain deferred; redaction is not the access-control boundary.

Implemented locally, not deployed. Girke OCR was verified with synthetic text; host log/backup retention remains unverified. Track deployment under [#155](https://github.com/devdogfish/quantself/issues/155); broader extraction/isolation decisions remain in [follow-up #33](https://github.com/devdogfish-workspace/todos/issues/33).

## Deployment

The Dell OptiPlex 5060 has an advertised i7-8700, 64 GB RAM, and 1 TB NVMe. Start with the app, API, PostgreSQL, and CPU-limited OCR in one private Quantself VM. Use containers inside the VM to manage services. Run client agents in separate VMs by trust boundary. Restrict agent access to the finance network, host management, mounts, credentials, and backup storage. Same-host isolation depends on the hypervisor. Separate hardware provides a stronger boundary.

Keep encrypted off-host backups of documents and their database metadata, and verify restoration before depending on Quantself as the sole live archive. Preserve unredacted tax evidence, including electronically issued originals. For paper business records, confirm the CRA imaging requirements before discarding originals. [CRA imaging guidance](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/keeping-records/acceptable-format-imaging-paper-documents-backing-electronic-files.html)

[Mermaid deployment and data flow diagram](research/budgeting-deployment-architecture.md)

## Optional Amazon and Inventory context

Evaluate with a few real order examples. A purchase line can link to an Amazon listing or variant and independently to an Inventory Item. The line records the quantity and price paid. Catalog specs describe the product, and Inventory owns the locations and quantities actually stored. One Amazon charge can cover several lines. All links are optional and can be added after import. Invoices can store one optional Amazon product ID. Extract it only when the invoice shows a single distinct ASIN, or let the Owner set it. The link opens the listing without automatic enrichment. Product facts and Inventory linking remain follow-ups that belong on purchase lines when an order has several products.

## Phone capture

The browser scanner starts with the Owner’s permission and shows a live crop outline. It captures a stable document, saves each scan automatically, and waits for the document to leave before arming again. Manual capture remains available. The temporary Tailscale inbox stages files on the Mac. Import staged files into the signed-in app when ready. It exposes no document browsing.

Phone photos and PDFs are both supported purchase-document inputs. They can represent the same document, but only identical original bytes are deduplicated automatically. Use one input for each document when possible. A redacted PDF can retain hidden text if the redactions were drawn as overlays. Treat the original and its text layer as private and share only a deliberately generated disclosure.

## Current budgeting priority (2026-11-08)

The first Budgeting page must prominently show projected net cash after scheduled mandatory expenses and a debt-payoff reserve, plus the number of additional full rent months that balance covers. Runway is the default view; Cash flow keeps the income-to-expense-category breakdown. Other views remain switchable.

The implemented rent-only calculation starts from available cash, adds remaining scheduled income through the configured end date, subtracts unpaid scheduled bills through that date, and subtracts the configured debt reserve. It assumes zero future Food and Other spending. Full rent months are the nonnegative leftover divided by monthly rent, rounded down. This is an end-date projection, not proof that every intervening payment is affordable on its due date. Timing and shortfalls must remain visible separately.

The Owner wants Food and Other allowances to come from the remainder after fixed obligations, rather than independently chosen limits. This preference must not be confused with the zero-discretionary assumption of the rent-only card.

Use the configured rent schedule, including month-end recurrence where applicable. Model recurring and one-time expected income as separate scheduled entries. Omit unknown amounts until supplied. Expected income contributes to the forecast. Cash checkpoints record available cash on a specific date, and debt reserves are also dated snapshots. Exclude credit availability from cash.

### Known completeness gaps

- Subscription renewals with established schedules now feed the forecast. Identified services without established billing intervals remain excluded and are visibly marked as needing a schedule. Past charges covered by the credit-card reserve do not cover future renewals.
- Debt reserve is a manually configured amount, not an automatically reconciled liability ledger. Updating balances or recording debt repayments must avoid subtracting the same liability twice.
- Income still comes from the plan; imported deposits are not automatically reconciled to scheduled pay.

### Persistence and deployment

Business rules live in this document and ADR 0036; implementation lives in the Budgeting API, database schema, and web components. Owner-specific amounts, dates, checkpoints, and imported records belong in the database, not this document.

Verify data imports and runway configuration in the intended environment. Independently confirm commits, pushes, deployments, and backups before reporting persistence.


## Subscriptions (2026-11-08)

- Subscriptions are first-class owner-scoped records, independent of the Budget Note. The Budgeting dashboard and dedicated Subscriptions page show one row per service, a locally served company logo (initials fallback), CAD charge, cadence, next expected payment, status, and optional manage/cancel links.
- Keep essentials: active/trial, dated cancellation, candidate/unscheduled records, editing, and monthly-equivalent cost. No reminders, auto-cancellation, credentials, or vendor integrations in this version.
- Version billing terms by effective date. The typed, bounded terms array preserves earlier amounts and anchors without introducing a general ledger. Daily intervals support actual 30-day plans; weekly, monthly, and yearly intervals share the same calendar arithmetic as ordinary bills. Month-end anchors clamp per month without drifting; yearly Feb 29 renewals clamp in non-leap years.
- The cancellation cutoff is exclusive: no expected charges **on or after** `stopsOn`. Charges already due and recorded payments remain. Clicking a vendor link only opens that site; recording cancellation asserts the Owner has handled it with the provider. Trial payments begin on the first paid renewal date.
- Calendar day/week/month views render expected payments as read-only all-day links to the subscription. They do not create Todos or consume task capacity. Paid occurrences show their matched amount. Calendar fetches are permission-gated and bounded to the displayed buffered range (maximum 186 days).
- Monthly equivalent spreads yearly costs over 12 months; daily/weekly cadences use 365.25 days per year. It is a comparison figure, not a cash-flow amount. Forecasts subtract the entire charge on its actual expected date. Remaining-this-month excludes matched payments. Cancellation savings represent the recurring monthly equivalent avoided once recorded cancellations take effect.
- Preserve CAD bank-posted amounts, including FX/taxes already reflected in those amounts. Foreign native amounts remain available alongside CAD estimates. See the currency rules below; reference-rate conversions never overwrite a CAD settlement.
- One occurrence key joins an expected payment to an actual expense. Matching requires known subscription merchant identity, an exact CAD amount, a posting date within three days, and unique candidates on both sides. Run reconciliation after either a bank import or subscription write. Explicit bill matching also supports subscription occurrences. Never fabricate transactions for future charges.
- Writes use per-record revisions and command IDs. The UI queues edits, Undo and Redo optimistically and retries uncertain delivery with the same payload. A rejected record does not discard another record's work. Table statistics update immediately; cash forecasts refresh after the server confirms payment reconciliation.
- Keep observed transactions as evidence. Include recurring charges in totals only once their billing interval and renewal date are known. Keep bank fees and historical dues separate unless confirmed as subscriptions.
- Source files and the local migration are saved; production rollout remains separate. [Architecture rationale](adr/0037-subscription-commitments.md).


### Subscription verification

Local API-handler measurements against the existing Docker database (eight subscriptions, November–December range; includes DB work and serialization, excludes browser/network/auth): list 142 ms cold / 33 ms warm, two queries, 5.0 KB; Calendar 50 / 21 ms, two queries, 2.1 KB; overview 114 / 37 ms, four queries, 9.1 KB. Each subscription table mount uses one list request; each Calendar range uses one subscription request, with no per-row requests. These are local observations, not production latency guarantees.

Regression checks cover month-end and 30-day recurrence, annual monthly equivalents, cancellation boundaries, retained price history, paid-charge replacement, ambiguous matching, owner isolation, stale revisions, idempotent retry, delayed responses, Undo/Redo and independent-record failure isolation. Browser verified local table, same-value save, and day/month Calendar expected/paid links.


## Currency conversion — approved 2026-11-08

- CAD remains the reporting/forecast currency. Original amounts and currency are preserved for foreign manual expenses and native-currency CSV imports; invoice currency and originals remain unchanged when linked to a bank expense. A CAD bank charge is authoritative even if an invoice or reference-rate conversion differs (fees, taxes, processor spread).
- The shared money module uses integer minor units and exact decimal multiplication with half-away-from-zero rounding once into the target currency. Supported fiat codes initially CAD, USD, EUR, CHF, GBP, AUD, NZD, JPY, CNY, SEK, NOK, DKK, KWD, BHD. Zero/three-decimal currencies are handled by currency metadata. Existing `totalCents`/`amountCents` field names are legacy; document/native subscription values mean that currency's minor units, while expense totals and forecast values are always CAD cents.
- Frankfurter v2 supplies daily reference estimates (not card/processor settlement rates). CAD/USD/EUR/CHF/GBP and other ECB-covered currencies explicitly use the ECB provider; KWD/BHD pairs use Frankfurter blended official-source estimates. Provider identity participates in the cache key and saved quote; no silent provider fallback. Requests send only currency codes/date ranges, never merchants, amounts, documents, or personal identifiers. Each saved expense conversion includes original/converted money, exact rate string, requested date, observed rate date, fetched time, source and provider. Existing saved conversions are reused on same-source-amount/date retries; historical amounts never revalue on read.
- Fetch in batches by source currency: multiple dates use a time-series request, grouped target currencies, at most four concurrent outbound requests. Cache public quotes in `budget_fx_rate`; historical quotes remain fixed, current-day rates refresh after six hours. Weekends/holidays use the latest preceding observed rate, surfaced by date. Missing/malformed/provider-failed or over-ten-day-old quotes fail explicitly and do not save a new expense as zero. Same currency/zero conversions do not call the provider. Long-lived copies remain usable during provider outages when an appropriate cached quote exists.
- Foreign subscription terms preserve native price/currency and a saved reference estimate. Read-only reporting refreshes the current/future terms' CAD estimate from current rates without changing terms or actual expenses. Free/discount periods can use zero-priced dated terms. No automatic first-paid date is inferred from an unclear promotion.
- Foreign invoice matching lists nearby posted expenses for explicit confirmation, without converting an estimate into proof of identity. Matching preserves the invoice amount and actual bank amount independently. Automatic amount-based matching remains restricted to CAD source amounts; foreign subscriptions require explicit paid-bill matching. Account transfers stay excluded from spending.
- Foreign bank CSV imports must select the bank account's native currency. A CAD credit-card export stays CAD even for purchases made abroad. Stable import IDs use original source amounts/currency, never changing exchange rates. No existing CAD record is rewritten by the additive migration.
- Currency conversion preview is `GET /api/v1/budgeting/currency/convert` (owner only). New foreign-price edits wait for a rate before entering optimistic subscription state because CAD totals cannot be predicted authoritatively; independent UI remains usable and changed drafts are preserved. Once quoted, existing serial optimistic queues/Undo/Redo handle subscription writes.
- OCR remains evidence extraction, not a guarantee: unsupported or ambiguous printed formats must retain the original and permit edits. The money/FX module itself is independent of OCR.
- Local migration applied only. No production deployment or existing transaction conversion performed.

Source: [Frankfurter v2 documentation](https://frankfurter.dev/) (verified 2026-11-08). Free/keyless historical and daily reference rates; persistent caching permitted. No availability SLA is assumed.

Currency verification: a live local batch of 100 synthetic conversions across USD/EUR/CHF/GBP to CAD took 608 ms cold (one cache read, four outbound requests, four bulk cache writes); warm 13 ms (one cache read, no outbound requests/writes). November 7 requests correctly used November 6 ECB observations. These are development measurements, not production latency guarantees. Browser checked CHF selection and authenticated conversion preview. Regression tests cover exact rounding/refunds/minor units, batching, concurrent request coalescing, stale/missing rates, weekend/future dates, native import identity, saved-rate retries, actual-CAD invoice matching, unknown invoice currencies, foreign forecasts and zero-price periods.

Foreign manual expenses similarly wait for the server conversion before changing CAD dashboard totals; showing their native number optimistically as CAD would be incorrect. Form pending feedback is immediate and independent dashboard actions remain available.

Implementation verification: full `bun run typecheck` passed. Full `bun run test` reached 1,357 passing / 7 skipped; the existing exclusive supervisor-socket test failed with the local dev server running. Focused currency/route/deferred-UI tests pass, including paginated foreign invoice suggestions. Source rules/ADR and additive migration are saved locally; no production rollout.

Use the subscription commands to import domain renewals as individual records with verified provider billing terms. Exclude domains with auto-renew disabled from forecasts and leave unknown prices unset. Dismiss an aggregate placeholder after verifying the individual records. Use the billed amount and interval for multi-year renewals. Keep account-specific evidence with private records.

### Opaque invoice transfer — 2026-11-08

The Owner permits downloading provider invoices and transferring their original bytes into Quantself, but does not permit the assistant to open, render, extract, OCR, or read their sensitive contents. Use only separately authorized billing metadata for names, renewal schedules, and known transaction links. Do not infer links from unopened files.

For this workflow, multipart `POST /api/v1/budgeting/receipts` uses `kind=invoice`, `scan=no`, a stable UUID, and `photo` containing the original PDF. New uploads are archived immediately and never enter the OCR queue. Omitting `scan` preserves ordinary automatic scanning. Upload responses expose only concealed document metadata; do not request `reveal=yes`, fetch originals back into model context, or consume document fields from matching responses.

Identical bytes deduplicate by owner-scoped SHA-256; retries retain the existing document ID. An existing queued/processing/failed document produces a conflict for an opaque upload rather than falsely claiming OCR was prevented. Deduplication does not undo extraction that happened before this privacy instruction. Different representations (photo versus PDF) still require explicit duplicate handling. Originals can link to a known bank expense through the existing owner-only match endpoint without manufacturing another expense; subscription association follows that expense's existing link. No external OCR service or model receives the files in this workflow.
