# Inventory UI Roadmap

## Intent

Inventory uses production routes, not the retired A/B/C inventory prototypes.
The roadmap focuses on completing Product stock controls and making asynchronous
processing understandable and recoverable.

## Confirmed Product Decisions

- `/inventory` is intentionally limited to Capture and search. Do not add a
  recent-captures feed or processing summary there.
- The production shell remains coupled to the shared mock Inventory records.
  They remain useful production reference data and are not cleanup work.
- Product detail supports Add Units, Move Units, and Remove Units.
- Merge Products is not part of the Inventory Product model or experience.
  Remove its UI, Web actions, API operation, generated Client contract, service
  behavior, and tests without a compatibility path.
- `/inventory/processing` remains a read-only overview. Recovery mutations
  belong on Product detail.

## Delivered 2026-08-01: Product Stock Controls

Route: `/inventory/items/[itemId]`.

Add a compact `Stock` section beside the Product's placement summary.

### Add Units

- Ask for positive quantity, default `1`.
- Ask for a destination Container or explicit unplaced stock.
- Show the updated total and Placement summary after success.

### Move Units

- Ask for source Placement, destination Container or unplaced stock, and
  positive quantity.
- Prevent identical source and destination choices.
- Reject quantities greater than the source Placement.
- Show the updated total and Placement summary after success.

### Remove Units

- Ask for source Placement and positive quantity.
- Explain before submission that removing the final unit Archives the Product.
- Reject quantities greater than the source Placement.
- Show the updated Placement summary, or the Archived result, after success.

### Stock-Control Constraints

- Reuse the API-owned idempotent Add, Move, and Remove commands.
- Never represent copies by duplicating Product facts or media.
- Keep source facts and Inventory Enrichment behavior unchanged.
- Do not include Merge Products controls or compatibility behavior.

## Delivered 2026-08-01: Adaptive Product Detail

Route: `/inventory/items/[itemId]`.

Use one API-backed Product detail page that adapts to workflow state.

### Proposal Mode

- Show source facts and proposed derived changes separately.
- Show the Inventory Text Bundle evidence supporting the proposal.
- Preserve clear Approve and Reject actions.

### Processing Mode

- Show the active preprocessing or enrichment stage.
- Show evidence types, current attempt, latest update, and expected next step.
- Do not expose Girke/Codex credentials or internal protocol details.

### Error Mode

- Name the failed stage and show a concise, useful error.
- Show attempt count, latest failure time, whether the failure is retryable, and
  whether partial Inventory Text Bundle content exists.
- Preserve successful partial evidence.
- Offer only the recovery action valid for the state.

### Complete Mode

- Show final Product facts, evidence, processed timestamps, and compact
  Inventory Enrichment history.
- Keep source facts visually distinct from applied derived values.

## Delivered 2026-08-01: Failure Recovery

Keep recovery on Product detail; Processing Board cards link to the relevant
Product and state the next action.

- Retryable preprocessing failure: `Retry preprocessing`.
- Retryable enrichment failure with a usable Inventory Text Bundle:
  `Retry enrichment`.
- Non-retryable failure or no usable text: `Edit source facts`.
- A retry uses current Product source evidence and creates fresh queued work.
- Retry commands are idempotent and reject with a conflict while equivalent
  work is already queued or processing.
- Do not add Cancel controls or inline Processing Board mutations.

## Next

- Video keyframe extraction for Inventory Preprocessing evidence.

## Planned: Inventory Item Detail UI Refinement

Route: `/inventory/items/[itemId]`.

- Place Edit, Archive, and Delete beside the Back control, outside the primary
  Inventory Item card.
- In Proposal mode, keep Approve and Reject in a fixed bottom action bar.
- When an Inventory Item has no images, put a full-width dashed upload/drop
  zone at the top of the primary card with a large plus icon and an Add images
  label. The first upload selects single- or multi-image mode automatically.
- Browse-card images use contained presentation only when every perimeter pixel
  is fully transparent (`alpha = 0`). Any nontransparent perimeter pixel keeps
  the existing cover presentation. Contained images receive no added padding;
  their source transparency provides the breathing room.
- Remove routine status, importance, and "No pending proposal" badges from the
  Inventory Item detail view. Keep those values editable. Display badges only
  for exceptional or actionable states such as Archived, Needs review, a
  processing failure, or a pending proposal.
- Make the Stock card the only detail-page display for total quantity,
  Placements, Container and Inventory Location labels, Placement notes, and the
  legacy free-text Where value. Do not repeat storage facts in the primary card
  or Proposal mode.
- Hide the Processing card after successful completion. While active, show only
  its title, current stage, and next action. On failure, add the concise error
  and valid recovery action. Present OCR and transcript text as compact previews
  with Read more and Read less controls. Hide attempts, timestamps,
  source-reference summaries, and processing history.
- Give image drop targets desktop-first tactile visual feedback: spring-like
  scale/pulse, border glow, and slight image compression while valid files hover.
  Do not request device vibration. Respect reduced-motion preferences.

## Intentional Limits

- Capture remains fast and independent of worker speed.
- Inventory Enrichment receives only an Inventory Text Bundle.
- Inventory Proposals require approval by default.
- No semantic embeddings.
- No movement history.
- No public worker protocol or hosted Agent/MCP integration.
- No Merge Products operation.
