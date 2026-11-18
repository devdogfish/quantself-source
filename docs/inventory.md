# Home Inventory

Inventory is API-first. The versioned QuantSelf API owns authentication,
authorization, validation, use cases, transactions, Prisma access, media
storage, and private worker protocols. Next.js owns presentation and thin
form-to-generated-Client adapters only.

## Current Shape

- Public contract and handlers: `apps/api/src/inventory-*-route.ts`
- API-owned domain behavior: `apps/api/src/inventory-*-service.ts`
- API-owned Prisma repository: `apps/api/src/inventory-prisma-repository.ts`
- API-owned media storage: `apps/api/src/inventory-storage.ts`
- Private worker protocol: `apps/api/src/inventory-worker-route.ts`
- Generated Web Client: `apps/web/lib/quantself-api-client.ts`
- Web presentation: `apps/web/app/inventory`
- Private worker executables: `apps/web/scripts/run-inventory-*-worker.ts`
- Container visual catalog: `apps/web/lib/inventory-container-visual-catalog.ts`
- Schema: `packages/db/prisma/models/inventory.prisma`

The executable OpenAPI document is the source for public API documentation:

- `/api/openapi.json`
- `/api/reference`
- `/api/reference.md`
- `/llms.txt`

## Behavior

- Active and Archived Inventory Item discovery and detail
- Item capture, updates, placement changes, archive, restore, and permanent deletion
- Inventory Placement add, move, remove, and atomic multi-Item moves
- Container CRUD, reference resolution, labels, visual presets, and bounds
- Capture Session defaults
- Authenticated Item Media upload, retrieval, ordering, and removal
- Inventory Preprocessing, Inventory Enrichment, proposal decisions, and
  approval preferences
- Private preprocessing and Codex enrichment workers using API-internal routes

Item capture accepts JSON for text-only Clients and multipart form data for
text and/or initial Item Media. A multipart capture persists the Item,
initial Placement, every initial Media record, and one preprocessing job in one
idempotent operation. The job starts only after the complete capture is saved,
so its source references include the Item and every initial file. Files added
or removed later use the standalone Item Media operation and queue refreshed
preprocessing.

Capture saves source evidence before asynchronous Inventory Preprocessing.
Inventory Enrichment receives only an Inventory Text Bundle. Inventory
Proposals require approval by default, and worker credentials remain restricted
to the internal deployment network.

## Intentional Limits

- Single Owner
- No semantic embeddings
- No movement history
- No public worker protocol or hosted Agent/MCP integration
- Private worker executables remain separate processes with persistent Codex
  login state

## Video Assets

Video files are Item Media and preprocessing evidence. Inventory
Preprocessing transcribes supported formats and sends Inventory Enrichment only
the resulting text bundle; keyframe extraction remains future work.
