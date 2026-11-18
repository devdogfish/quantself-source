# Budgeting module (#175)

The Budgeting module uses the Quantself API. The approved design remains the reference for layout and interactions.

## Pages

| Route | Component | Purpose |
|---|---|---|
| `/budgeting` | `overview.tsx` | Insights only, nothing editable. Week/Month period, statement panel that opens into Income / Bills / Savings / Spending, cash balance + forecast, Coming up belt. Every number links to the page holding its rows. |
| `/budgeting/log` | `log.tsx` | Recording. Add expense, then the daily check-in: review → week → skipped spending → next week. |
| `/budgeting/transactions` | `transactions.tsx` | Every expense as raw data. URL state includes date range, month, category, segment, search, subscription, spending drill-down and drawer ID. |
| `/budgeting/subscriptions` | `subscriptions.tsx` | One row per recurring rule, with per-month and per-year totals. URL state: `seg`, drawer `id`. |
| `/budgeting/documents` | `documents.tsx` | Receipts, invoices and agreements, linked to the money they explain. Drawer `id`. |

Plan, Can I afford this?, Tax planning, Import and Receipts are the existing pages. `../budgeting-shell.tsx` gives
them the old column and tab row; the five pages above use `frame.tsx` (`PageHeader` with the tabs in `nav`).

## Data access

- `stub-store.tsx` exposes `useBudgetStore()` and `useBudgetNumbers()`. It combines the Overview, Transaction, Log and recurring-rule reads with optimistic changes. `ledger.ts` selects the requested statement and balance range from the Overview response.
- `transaction-client.ts` and `subscriptions-data.ts` read and write through the generated API contract. The shared queues keep changes and Undo available across Budgeting pages while saves are pending.
- `documents.tsx` exposes `useDocuments()`. The receipts API supplies filtered pages, counts, exports, related records and originals. Private fields and originals load on reveal.
- The receipts library still serves Tax planning's document lookup, ID copy and receipt editor. Upload document opens the scanner and upload controls on that route.

Normal browser request counts after authentication:

| Action | API requests |
|---|---:|
| Open Overview or change its statement period | 1 |
| Change the cash chart range | 0 |
| Open Transactions, change its filters or page | 1 |
| Open a loaded transaction drawer / open via deep link | 0 / 1 additional |
| Open Log or Subscriptions | 1 |
| Open Tax Planning or change its tax year | 1 |
| Toggle a tax claim | 0 |
| Open Documents, change its filters or page, or reveal list details | 1 |
| Open a loaded document drawer / open via deep link | 0 / 1 additional |
| Reveal a document with an original | 2 |
| Download an original already used for preview | 0 |
| Export filtered Transactions or Documents | 1 |
| Export filtered Subscriptions | 0 |

Follow the repository performance and responsive interaction requirements. Verify optimistic writes with deferred responses.

## Design rules the Owner settled

- Keep insights and recording on separate pages. The Overview never edits data.
- Page headers have no subtitle. They hold a title, actions, the tabs and optionally a facts row.
- Table rows are one line of text. Pagination is the bare `TablePagination`, not wrapped in another box.
- "View more in …" is the last row of a section, aligned with the rows. Never right-aligned like a total.
- The Coming up belt moves 1 device pixel every N frames, so text stays sharp and the rhythm stays even.

The full prototype history and research are on branch `prototype/budgeting-175`.
