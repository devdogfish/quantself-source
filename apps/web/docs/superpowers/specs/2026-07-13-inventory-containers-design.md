# Inventory Containers

Date: 2026-07-13
App: `apps/web`
Status: draft for review

## Summary

Add first-class containers to home inventory. Items can be assigned to a saved container instead of a free-text label. A container has an ID, reference ID, location, optional front-view photo, and size in liters. Capture uses a suggested dropdown with create-new flow. A new containers page shows every container with summaries and three prototype views, including a visual view that clips scattered item images inside a 2D container frame.

## Problem

Inventory currently treats containers as plain text through `defaultContainerLabel` and `containerLabel`. That creates duplicate labels, makes capture easy to mistype, and prevents a real containers page. The user wants the container to be a concrete inventory entity: stored in a location, photographed, sized, selected from known values, and browsable as a collection.

## Goals

- Add a simple `InventoryContainer` database model.
- Store each container in a location.
- Store a reference ID separate from the database ID.
- Store size in liters.
- Store one optional container photo.
- Assign captured items to an existing container via a dropdown or autocomplete-like select.
- Allow creating a new container from the capture form in a dialog/sheet.
- Add `/inventory/containers`.
- Show all containers with item counts, location, size, and sample item images.
- Create three container page prototype views on one route.
- Include a view where item images are scattered inside a clipped 2D container frame.
- Keep old `containerLabel` behavior compatible while existing data still has labels only.
- Avoid extra container complexity beyond the requested fields and views.

## Non-Goals

- No nested containers.
- No capacity calculations beyond storing/displaying liters.
- No drag-and-drop item placement.
- No bulk migration UI for old label-only items.
- No multi-photo gallery for containers.
- No geospatial or room map model.
- No production-quality final visual selection from the prototype variants in this pass.

## Chosen Approach

Use a real container entity and keep the old label fields as compatibility fields for now.

`InventoryContainer` becomes the source for selectable containers and the containers page. `InventoryItem.containerId` links new captures to a container. `InventoryCaptureSession.defaultContainerId` can hold the active default container. `containerLabel` remains nullable and populated from the selected container name or old free-text fallback so existing search, enrichment snapshots, and history UI keep working during the transition.

This keeps the data model simple, avoids a risky backfill-only cutover, and gives the UI a real entity for dropdown suggestions and container summaries.

## Alternatives Considered

### Label-Only Improvements

Keep `containerLabel` and build suggestions from distinct labels.

Pros: smallest schema change.
Cons: cannot store photo, reference ID, size liters, or authoritative location cleanly. Duplicate labels remain likely.

### Full Replacement

Remove `containerLabel` and require every item to have `containerId`.

Pros: cleaner final model.
Cons: risky with existing captures, tests, enrichment snapshots, and search text. Requires immediate backfill and stronger migration decisions.

### Chosen Hybrid

Add `containerId` now and keep `containerLabel` as a compatibility/search field.

Pros: supports requested feature now, keeps old data readable, lowers migration risk.
Cons: temporary duplication until a later cleanup/backfill pass.

## Data Model

Add:

```prisma
model InventoryContainer {
  id             String   @id @default(cuid())
  referenceId    String   @unique
  name           String
  normalizedName String   @unique
  locationId     String?
  sizeLiters     Float?
  photoFilePath  String?
  metadata       Json?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  location        InventoryLocation?        @relation(fields: [locationId], references: [id], onDelete: SetNull)
  defaultSessions InventoryCaptureSession[]
  items           InventoryItem[]

  @@index([locationId, name])
  @@map("inventory_container")
}
```

Update:

- `InventoryItem.containerId String?`
- `InventoryItem.container InventoryContainer?`
- `InventoryCaptureSession.defaultContainerId String?`
- `InventoryCaptureSession.defaultContainer InventoryContainer?`
- Keep `InventoryItem.containerLabel String?`
- Keep `InventoryCaptureSession.defaultContainerLabel String?`

Reference ID generation should be deterministic enough for local use, for example `BIN-0001` style or a normalized user-provided value. The create flow should accept a manual reference ID and generate one when omitted.

## Domain Service

Add container domain records and repository methods:

- `InventoryContainerRecord`
- `InventoryContainerSummary`
- `upsertContainer(input)`
- `getContainer(id)`
- `listContainers()`
- `listContainerSummaries()`

Creation normalizes names with the same spirit as locations: trim, collapse whitespace, lower-case for uniqueness.

Item creation resolves container in this order:

1. explicit `containerId`
2. explicit create-new result used by the form
3. session `defaultContainerId`
4. legacy `containerLabelOverride`
5. session `defaultContainerLabel`

When a container is resolved, `containerLabel` is set to the container name for compatibility.

## Capture Form

Replace the free-text container override with a controlled container picker:

- Shows current/session default container.
- Lists known containers with name, reference ID, location, and liters.
- Allows text filtering inside the picker.
- Stores selected value as `containerId`.
- Includes a `Create container` button.
- Opens a sheet/dialog to create a container.

Create container fields:

- name, required
- reference ID, optional
- location, optional text field using current location upsert behavior
- size liters, optional numeric input
- photo, optional image upload

After create succeeds:

- new container is selected in the capture form
- `/inventory` and `/inventory/containers` revalidate
- action message confirms container creation

The form should not allow arbitrary container text as the primary path.

## Containers Page

Route: `/inventory/containers`

Add `containers` to inventory shell navigation.

The page should fetch container summaries and render three prototype variants, switchable by query param, for example `?variant=grid`, `?variant=visual`, and `?variant=audit`.

Shared summary data:

```ts
type InventoryContainerSummary = {
  id: string;
  referenceId: string;
  name: string;
  locationName: string | null;
  sizeLiters: number | null;
  photoFilePath: string | null;
  itemCount: number;
  sampleImages: Array<{
    id: string;
    alt: string;
    caption: string | null;
  }>;
  latestCapturedAt: Date | null;
};
```

## Prototype Views

Use the prototype skill shape: one route, three structurally different variants, and a fixed development-only switcher.

### Variant A: Dense Grid

Cards optimized for scanning many containers. Each card shows container name, reference ID, location, liters, item count, and a small image strip.

### Variant B: Visual Bin

Large visual cards. A simple front-view container frame uses the container photo when present, or a generated CSS frame when missing. Sample item images are absolutely positioned with stable rotations and clipped by the frame so they appear inside the container.

### Variant C: Audit Table

Dense table/hybrid view for operations. Rows show reference ID, name, location, liters, item count, latest capture, and thumbnails. Best for verifying the data model and searchability.

The visual variant is expected to be the most domain-specific one, but the route should make it easy to compare all three.

## Image Handling

Container photos use a separate file path on `InventoryContainer.photoFilePath`; they are not item images.

Item sample images come from existing `InventoryItemImage` rows. Existing `/inventory/images/[imageId]` can serve item images. Container photo serving can either reuse a small route under `/inventory/containers/[containerId]/photo` or extend repository helpers with a container photo file lookup.

## Search And Display Compatibility

Search remains compatible with `containerLabel`.

New items with `containerId` should include container name, reference ID, and location in generated search text. Old items without `containerId` keep using `containerLabel`.

History, processing, and item detail can keep displaying a label, but should prefer linked container data when available:

```text
Container name (REF-001)
```

## Error Handling

- Creating a container without a name returns a form error.
- Duplicate container names return a clear error.
- Duplicate reference IDs return a clear error.
- Invalid liters input is ignored or rejected with a form error; prefer rejection for user feedback.
- Missing container photo is valid.
- Missing container assignment on an item is still valid for legacy and unplaced captures.
- If image upload succeeds but container create fails, return an error and do not select a phantom container.

## Migration Plan

1. Add schema fields and migration.
2. Generate Prisma client.
3. Add repository mapping and query methods.
4. Add domain service types and container resolution.
5. Add server actions for create-container and capture with `containerId`.
6. Add capture picker and create sheet.
7. Add containers page, nav, summaries, and prototype switcher.
8. Update tests and mocks.

Backfill is optional in this pass. Old `containerLabel` rows should remain visible through legacy display paths.

## Test Plan

Add or update:

- `lib/inventory-service.test.ts`
  - creates containers
  - resolves session default container
  - assigns item container by ID
  - preserves legacy label fallback
  - includes container name/reference in search text
- `lib/inventory-prisma-repository.test.ts`
  - maps container relations
  - creates items with `containerId`
  - lists container summaries with sample images
- `app/inventory/actions.test.ts`
  - parses `containerId`
  - creates container action
  - revalidates `/inventory` and `/inventory/containers`
- `app/inventory/capture-session-card.test.tsx`
  - renders picker, not free-text container input
  - selects an existing container
  - opens create sheet
- `app/inventory/inventory-shell.test.tsx`
  - includes Containers nav
  - renders containers route smoke

Verification commands:

```bash
bun test app/inventory/actions.test.ts app/inventory/capture-session-card.test.tsx app/inventory/inventory-shell.test.tsx 'app/inventory/items/[itemId]/page.test.tsx' lib/inventory-service.test.ts lib/inventory-prisma-repository.test.ts
bun test
cd ../.. && bun run db:generate && bun run typecheck
```

## Acceptance Criteria

- Database has a first-class `InventoryContainer`.
- Container includes ID, reference ID, location, optional photo, and size liters.
- Capture form no longer uses arbitrary free text as the main container input.
- Capture form can create a new container from a dialog/sheet.
- New captured items can be assigned to a container.
- `/inventory/containers` exists.
- Inventory nav links to Containers.
- Containers page shows all containers and summary data.
- Containers page has three switchable prototype views.
- One view clips scattered item images inside a 2D container/front-view frame.
- Existing label-only items still display/search acceptably.
- Focused tests and typecheck pass.

## Spec Self-Review

- No placeholder requirements remain.
- Scope is one coherent feature: container entity, capture assignment, and containers page prototypes.
- The chosen hybrid data model avoids contradicting existing label-based search.
- Ambiguity resolved: container photo is one optional file path on the container, item images remain separate.
- Ambiguity resolved: size is stored as liters in a nullable numeric field.
