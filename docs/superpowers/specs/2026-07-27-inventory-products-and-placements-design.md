# Inventory Products and Placements

Status: amended 2026-08-01

## Goal

Represent interchangeable copies once while tracking how many exist in each
container.

Example: one `Life Solution DUO water-disinfection kit` product has total
quantity `2`, with quantity `1` in R1 and quantity `1` in B1. Its title, notes,
photos, tags, and aliases exist once.

## Domain Model

### Inventory Product

The canonical shared record. It owns:

- title and item/group kind;
- shared notes and capture text;
- importance and category;
- tags, aliases, and search text;
- images, audio, and files;
- enrichment history and proposals.

### Inventory Placement

A quantity of one product stored in one container. It owns:

- product;
- nullable container;
- positive integer quantity;
- optional placement note;
- timestamps.

There may be at most one placement per product and container. Unplaced stock
uses one placement with a null container. Product total quantity is the sum of
its placements.

Unit-specific serial numbers, condition, batch, and expiry tracking are outside
this first version. Do not create a physical-unit table yet.

## Capture UX

Capture must support two explicit paths:

1. `Create new product`
2. `Add units to existing product`

Default to the second path when search or enrichment finds a likely match.
Show the candidate's image, title, total quantity, and current placements.
Primary action: `Add units to this product`. Secondary action:
`Create separate product`.

Never combine Products during capture. Adding units to an existing Product or
creating a separate Product must always be an explicit choice.

Adding units asks only for:

- existing product;
- quantity, default `1`;
- destination container.

It does not request or duplicate shared metadata or media. After saving, show:
`Added 1 · Total 2 · R1 1 · B1 1`.

## Product and Container Views

Product detail shows:

- shared product information once;
- total quantity;
- a `Stored in` list with quantity per container;
- `Add units`, `Move units`, and `Remove units` actions.

Browse and search show one card per product with a total quantity badge and
location summary.

Container views show each product once per container with the quantity stored
there. Editing product information updates every view immediately.

## Moving Stock

`Move units` requires source container, destination container, and quantity.
The operation atomically decrements the source and increments or creates the
destination placement. Delete a placement when its quantity reaches zero.
Reject moves exceeding source quantity.

## No Product Merge

Do not expose or retain a Merge Products operation. Product detail supports
Add Units, Move Units, and Remove Units only. Remove existing Merge Products UI,
Web actions, API operations, generated Client contract, service behavior, and
tests without a compatibility path.

Duplicate Products remain separate records. The owner may correct their facts,
adjust their Placements, Archive one, or Delete one through ordinary Product
operations.

## Data Changes

- Keep `InventoryItem` as the initial product table to minimize migration cost.
- Add `InventoryItemPlacement` with `itemId`, nullable `containerId`,
  `quantity`, optional `note`, and timestamps.
- Unique constraint: `(itemId, containerId)` for assigned placements.
- Enforce one unplaced placement per item in repository logic.
- Move `containerId` and `containerLabel` responsibility from
  `InventoryItem` to placements.
- Migrate every existing item to one placement with quantity `1`.
- Keep media and enrichment relations attached to `InventoryItem`.

## Acceptance Scenarios

1. Adding the second DUO kit to B1 creates no second product or duplicated
   photos.
2. Product detail reports total `2`, R1 `1`, B1 `1`.
3. Moving one unit from B1 to R1 produces total `2`, R1 `2`, no B1 placement.
4. Container and browse views show correct local and total quantities.
5. Capture suggests an existing match, but the owner must explicitly add units
   to it or create a separate Product.
6. Existing inventory migrates with unchanged container contents and quantity
   `1`.
7. No UI, Web action, API operation, or service behavior supports merging
   Products.

## Verification

- Prisma migration and repository tests for placement uniqueness, totals, and
  atomic moves.
- Capture tests for existing-product selection and explicit duplicate escape.
- Product, browse, search, and container tests for quantity presentation.
- Contract and boundary tests prove Merge Products is absent.
- Run Prisma validation/generation, focused tests, typecheck, and lint.
