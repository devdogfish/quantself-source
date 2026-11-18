# Purchase planning and inventory evidence

Implemented locally, November 8, 2026.

## Income and rent

Reuse the existing structured schedule for recurring and one-time income. Omit unknown amounts until supplied and count each occurrence once.

Rent is a recurring housing obligation, not a subscription. Both feed the common forecast. Calendar displays plan bills and income separately from subscription payments, using stable occurrence keys and bulk payment matching. No synthetic tasks or habits are created. Calendar income remains expected, not bank-confirmed. Preserve the configured rent schedule, including month-end recurrence where applicable.

## Can I afford this?

`/budgeting/affordability` accepts a CAD amount and purchase date within the next year. Preview does not write an expense, change a balance, or modify the plan. It uses the current checkpoint, qualifying actual expenses, scheduled income and bills, and active subscription occurrences. Matched actual payments replace estimates. Debt is reserved once, up front, for conservative timing checks; no future Food/Other spending is assumed.

Show before/after projected leftover at the configured runway date, additional full rent months, and first shortfall within the next year. A purchase after the runway date changes later timing but not that earlier balance. Missing cash remains unknown. Forecasts depend on the completeness of recorded obligations; they are not proof of affordability outside the forecast period.

## Inventory links

Optional many-to-many links connect a receipt/invoice or expense with existing inventory items. Links are independent of bill and subscription matching. They neither create expenses nor modify inventory costs or quantities. Database foreign keys enforce valid references and owner-scoped finance sources; unique indexes make identical retries safe. Deleting a source or item removes only its association rows.

The first UI links at document/expense level. Stable structured purchase-line identities and per-line allocations remain future work; OCR line positions are not durable IDs. Item linking is available on receipt details and in recent-expense actions. Search is explicit, limited to 20 results, with a narrowing hint; no per-row requests. Owner Session plus Budgeting permission and inventory read permission are required.

Link/unlink is optimistic, serialized, and supports Undo/Redo during delayed saves. Uncertain delivery retains intent for identical retry. Definitive rejection reverts only that item's queued changes while preserving unrelated work.

## Data access

Affordability uses three bulk reads: plan and subscriptions concurrently, followed by relevant expenses. Calendar plan events use at most two reads: plan then paid occurrence keys. Calendar ranges are capped at 186 days and fetched once per visible range. Inventory linking reads its source first to establish owner access, then uses one joined query. No original receipt images are included.
