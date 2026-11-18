import { describe, expect, it } from "bun:test";
import type { Prisma } from "@quantself/db/generated/prisma/client";
import { createApp } from "./app";
import { createInventoryItemCaptureRouteHandlers } from "./inventory-capture-route";
import { InventoryImageNormalizationError } from "./inventory-image-normalization";

const ownerAccessContext = {
  owner: {
    email: "owner@example.com",
    id: "user-1",
    name: "QuantSelf Owner",
  },
  client: {
    id: "user-1",
    kind: "web" as const,
    name: "QuantSelf Owner",
  },
  permissions: ["inventory:read", "inventory:write"],
};

function buildInventoryItem() {
  return {
    acquisitionSource: null,
    aliases: [],
    archivedAt: null,
    captureText: "Passport pouch with charger and pen.",
    capturedAt: "2026-07-28T12:00:00.000Z",
    category: null,
    clothingProfile: null,
    remedyProfile: null,
    containerId: "container-1",
    containerLabel: "Blue bin 4 (BIN-0004)",
    costCents: null,
    costCurrency: "CAD",
    id: "item-1",
    imageId: null,
    importance: "MEDIUM" as const,
    kind: "GROUP" as const,
    note: null,
    placementSummary: "Total 2 · Blue bin 4 (BIN-0004) 2",
    placements: [
      {
        containerId: "container-1",
        label: "Blue bin 4 (BIN-0004)",
        locationId: null,
        locationName: null,
        note: null,
        placementId: "placement-1",
        quantity: 2,
      },
    ],
    processing: {
      currentStep: "Wait for background processing",
      enrichment: {
        attempts: 0,
        failedAt: null,
        failureMessage: null,
        maxAttempts: 3,
        rationale: "Inventory Enrichment has not started.",
        retryable: false,
        status: "NOT_STARTED" as const,
        summary: "Inventory Enrichment has not started.",
        updatedAt: "2026-07-28T12:00:00.000Z",
      },
      evidence: [],
      history: [],
      nextAction: "Wait for background processing",
      preprocessing: {
        attempts: 0,
        failedAt: null,
        failedSteps: [],
        failureMessage: null,
        maxAttempts: 3,
        mediaTexts: [],
        status: "CAPTURED" as const,
        summary: "Saved evidence is waiting for preprocessing pickup.",
        textBundleAvailable: false,
        retryable: false,
        updatedAt: "2026-07-28T12:00:00.000Z",
      },
      proposal: {
        status: "NONE" as const,
        summary: "No pending Inventory Proposal.",
        updatedAt: "2026-07-28T12:00:00.000Z",
      },
      sourceLabel: "Inventory capture",
    },
    status: "UNSURE" as const,
    tags: [],
    title: "Passport pouch",
    totalQuantity: 2,
    where: "Blue bin 4 (BIN-0004)",
  };
}

describe("inventory capture routes", () => {
  it("returns the active Capture Session through the API seam", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryCaptureSession: {
        getActiveSession: async () => ({
          container: null,
          containerLabel: null,
          destinationLocation: "Hall closet",
          id: "session-1",
          label: "Apartment reset",
          note: null,
          originRoom: "Office",
        }),
        saveDefaults: async () => {
          throw new Error("saveDefaults should not run");
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
    });

    const response = await app.request("/api/v1/inventory-capture-session");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      session: {
        container: null,
        containerLabel: null,
        destinationLocation: "Hall closet",
        id: "session-1",
        label: "Apartment reset",
        note: null,
        originRoom: "Office",
      },
    });
  });

  it("requires Idempotency-Key to save Capture Session defaults", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryCaptureSession: {
        getActiveSession: async () => null,
        saveDefaults: async () => {
          throw new Error("saveDefaults should not run");
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
    });

    const response = await app.request("/api/v1/inventory-capture-session", {
      body: JSON.stringify({
        destinationLocation: "Hall closet",
        id: "session-1",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "PUT",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_IDEMPOTENCY_KEY",
      message:
        "Idempotency-Key header is required and must not exceed 255 characters.",
    });
  });

  it("rejects a capture without text evidence before calling the handler", async () => {
    let calls = 0;
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemCapture: {
        captureItem: async () => {
          calls += 1;
          throw new Error("captureItem should not run");
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
    });

    const response = await app.request("/api/v1/inventory-items/capture", {
      body: JSON.stringify({ captureText: "   " }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "capture-item-invalid",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "Request validation failed.",
    });
    expect(calls).toBe(0);
  });

  it("captures an image-only Item through one multipart request", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemCapture: {
        captureItem: async (input) => {
          calls.push(input);

          return {
            media: [
              {
                contentType: "image/jpeg",
                id: "image-1",
                kind: "image" as const,
                originalName: "front.jpg",
                position: 0,
                sizeBytes: 5,
              },
            ],
            preprocessingJob: { id: "job-1", status: "QUEUED" as const },
            item: buildInventoryItem(),
          };
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
      unsafeSkipContractValidationForTests: true,
    });
    const body = new FormData();
    body.append(
      "metadata",
      JSON.stringify({
        category: "clothing",
        locationId: "location-wardrobe",
      }),
    );
    body.append(
      "files",
      new File(["front"], "front.jpg", { type: "image/jpeg" }),
    );

    const response = await app.request("/api/v1/inventory-items/capture", {
      body,
      headers: { "Idempotency-Key": "capture-image-1" },
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      media: [{ id: "image-1", originalName: "front.jpg" }],
      preprocessingJob: { id: "job-1", status: "QUEUED" },
      item: { id: "item-1" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      clientId: "user-1",
      files: [expect.objectContaining({ name: "front.jpg", size: 5 })],
      idempotencyKey: "capture-image-1",
      operation: "captureInventoryItem",
      request: {
        category: "clothing",
        captureText: null,
        locationId: "location-wardrobe",
        note: null,
        quantity: 1,
        title: null,
      },
    });
  });

  it("rejects HEIC and HEIF during multipart Item capture", async () => {
    let calls = 0;
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemCapture: {
        captureItem: async () => {
          calls += 1;
          throw new Error("captureItem should not run");
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
      unsafeSkipContractValidationForTests: true,
    });
    const body = new FormData();
    body.append("metadata", "{}");
    body.append(
      "files",
      new File(["image"], "photo.heif", { type: "application/octet-stream" }),
    );

    const response = await app.request("/api/v1/inventory-items/capture", {
      body,
      headers: { "Idempotency-Key": "capture-heif-1" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "HEIC and HEIF images are not supported.",
    });
    expect(calls).toBe(0);
  });

  it("returns a stable validation error when capture normalization fails", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemCapture: {
        captureItem: async () => {
          throw new InventoryImageNormalizationError(
            "Image could not be normalized.",
          );
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
      unsafeSkipContractValidationForTests: true,
    });
    const body = new FormData();
    body.append("metadata", "{}");
    body.append(
      "files",
      new File(["broken"], "broken.png", { type: "image/png" }),
    );

    const response = await app.request("/api/v1/inventory-items/capture", {
      body,
      headers: { "Idempotency-Key": "capture-broken-image" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "Image could not be normalized.",
    });
  });

  it("captures an audio-only Item without fake text", async () => {
    const calls: Array<{ files: File[]; request: Record<string, unknown> }> =
      [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemCapture: {
        captureItem: async (input) => {
          calls.push(input);
          return {
            media: [
              {
                contentType: "audio/webm",
                id: "audio-1",
                kind: "audio" as const,
                originalName: "note.webm",
                position: null,
                sizeBytes: 5,
              },
            ],
            preprocessingJob: { id: "job-1", status: "QUEUED" as const },
            item: buildInventoryItem(),
          };
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
      unsafeSkipContractValidationForTests: true,
    });
    const body = new FormData();
    body.append("metadata", "{}");
    body.append(
      "files",
      new File(["voice"], "note.webm", { type: "audio/webm" }),
    );

    const response = await app.request("/api/v1/inventory-items/capture", {
      body,
      headers: { "Idempotency-Key": "capture-audio-1" },
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(calls[0]?.request.captureText).toBeNull();
    expect(calls[0]?.files[0]?.name).toBe("note.webm");
  });

  it("rejects empty or malformed multipart capture before mutation", async () => {
    let calls = 0;
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemCapture: {
        captureItem: async () => {
          calls += 1;
          throw new Error("captureItem should not run");
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
      unsafeSkipContractValidationForTests: true,
    });
    const empty = new FormData();
    empty.append("metadata", "{}");
    const malformed = new FormData();
    malformed.append("metadata", "not-json");

    const [emptyResponse, malformedResponse] = await Promise.all([
      app.request("/api/v1/inventory-items/capture", {
        body: empty,
        headers: { "Idempotency-Key": "capture-empty-1" },
        method: "POST",
      }),
      app.request("/api/v1/inventory-items/capture", {
        body: malformed,
        headers: { "Idempotency-Key": "capture-malformed-1" },
        method: "POST",
      }),
    ]);

    expect(emptyResponse.status).toBe(400);
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "Multipart metadata must be valid JSON.",
    });
    expect(calls).toBe(0);
  });

  it("rejects unsupported capture currency before calling the handler", async () => {
    let calls = 0;
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemCapture: {
        captureItem: async () => {
          calls += 1;
          throw new Error("captureItem should not run");
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
    });

    const response = await app.request("/api/v1/inventory-items/capture", {
      body: JSON.stringify({
        captureText: "Passport pouch",
        costCurrency: "USD",
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "capture-item-invalid-currency",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "Request validation failed.",
    });
    expect(calls).toBe(0);
  });

  it("rejects unsupported capture media types without throwing", async () => {
    let called = false;
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemCapture: {
        captureItem: async () => {
          called = true;
          throw new Error("captureItem should not run");
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
    });

    const response = await app.request(
      "/api/v1/inventory-items/capture",
      {
        body: "Navy hoodie",
        headers: {
          "content-type": "text/plain",
          "idempotency-key": "unsupported-capture-media-1",
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      code: "UNSUPPORTED_MEDIA_TYPE",
      message:
        "Inventory Item capture requires application/json or multipart/form-data.",
    });
    expect(called).toBe(false);
  });

  it("documents and bounds Idempotency-Key", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      resolveAccessContext: async () => ownerAccessContext,
    });
    const document = (await (
      await app.request("/api/openapi.json")
    ).json()) as {
      paths: Record<
        string,
        {
          post?: {
            parameters?: Array<Record<string, unknown>>;
          };
          put?: {
            parameters?: Array<Record<string, unknown>>;
          };
        }
      >;
    };
    const saveHeader =
      document.paths["/api/v1/inventory-capture-session"]?.put?.parameters?.[0];
    const captureHeader =
      document.paths["/api/v1/inventory-items/capture"]?.post
        ?.parameters?.[0];

    expect(saveHeader).toMatchObject({
      in: "header",
      name: "Idempotency-Key",
      required: true,
      schema: {
        maxLength: 255,
        minLength: 1,
        type: "string",
      },
    });
    expect(captureHeader).toEqual(saveHeader);

    const response = await app.request("/api/v1/inventory-items/capture", {
      body: JSON.stringify({ captureText: "Passport pouch" }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "x".repeat(256),
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_IDEMPOTENCY_KEY",
      message:
        "Idempotency-Key header is required and must not exceed 255 characters.",
    });
  });

  it("passes Capture Session defaults plus client permission into the handler", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryCaptureSession: {
        getActiveSession: async () => null,
        saveDefaults: async (input) => {
          calls.push(input);

          return {
            container: null,
            containerLabel: "Blue bin 4",
            destinationLocation: "Hall closet",
            id: "session-1",
            label: "Apartment reset",
            note: "Keep travel gear together.",
            originRoom: "Office",
          };
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
    });

    const response = await app.request("/api/v1/inventory-capture-session", {
      body: JSON.stringify({
        defaultContainerId: "container-1",
        defaultContainerLabel: "Blue bin 4",
        destinationLocation: "Hall closet",
        id: "session-1",
        label: "Apartment reset",
        note: "Keep travel gear together.",
        originRoom: "Office",
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "capture-session-1",
      },
      method: "PUT",
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        clientId: "user-1",
        idempotencyKey: "capture-session-1",
        operation: "saveInventoryCaptureSessionDefaults",
        request: {
          defaultContainerId: "container-1",
          defaultContainerLabel: "Blue bin 4",
          destinationLocation: "Hall closet",
          id: "session-1",
          label: "Apartment reset",
          note: "Keep travel gear together.",
          originRoom: "Office",
        },
      },
    ]);
  });

  it("captures an Item with Idempotency-Key scoped to the client", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryCaptureSession: {
        getActiveSession: async () => null,
        saveDefaults: async () => {
          throw new Error("saveDefaults should not run");
        },
      },
      inventoryItemCapture: {
        captureItem: async (input) => {
          calls.push(input);

          return {
            media: [],
            preprocessingJob: { id: "job-1", status: "QUEUED" as const },
            item: buildInventoryItem(),
          };
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
    });

    const response = await app.request("/api/v1/inventory-items/capture", {
      body: JSON.stringify({
        captureSessionId: "session-1",
        captureText: "Passport pouch with charger and pen.",
        quantity: 2,
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "capture-item-1",
      },
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      media: [],
      preprocessingJob: { id: "job-1", status: "QUEUED" },
      item: buildInventoryItem(),
    });
    expect(calls).toEqual([
      {
        clientId: "user-1",
        files: [],
        idempotencyKey: "capture-item-1",
        operation: "captureInventoryItem",
        request: {
          acquisitionSource: null,
          captureSessionId: "session-1",
          captureText: "Passport pouch with charger and pen.",
          category: null,
          containerId: undefined,
          containerLabelOverride: null,
          costCents: null,
          costCurrency: "CAD",
          importance: null,
          kind: null,
          note: null,
          quantity: 2,
          status: null,
          title: null,
        },
      },
    ]);
  });

  it("passes direct location capture and rejects mixed container plus location targets", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryItemCapture: {
        captureItem: async (input) => {
          calls.push(input);

          return {
            media: [],
            preprocessingJob: { id: "job-1", status: "QUEUED" as const },
            item: buildInventoryItem(),
          };
        },
      },
      resolveAccessContext: async () => ownerAccessContext,
    });

    const directLocationResponse = await app.request(
      "/api/v1/inventory-items/capture",
      {
        body: JSON.stringify({
          captureText: "Pantry oat milk",
          category: "food",
          locationId: "location-pantry",
          quantity: 2,
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "capture-item-location-1",
        },
        method: "POST",
      },
    );
    const conflictingTargetResponse = await app.request(
      "/api/v1/inventory-items/capture",
      {
        body: JSON.stringify({
          captureText: "Pantry oat milk",
          containerId: "container-1",
          locationId: "location-pantry",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "capture-item-location-conflict-1",
        },
        method: "POST",
      },
    );

    expect(directLocationResponse.status).toBe(201);
    expect(calls).toEqual([
      {
        clientId: "user-1",
        files: [],
        idempotencyKey: "capture-item-location-1",
        operation: "captureInventoryItem",
        request: {
          acquisitionSource: null,
          captureSessionId: null,
          captureText: "Pantry oat milk",
          category: "food",
          containerId: undefined,
          containerLabelOverride: null,
          costCents: null,
          costCurrency: "CAD",
          importance: null,
          kind: null,
          locationId: "location-pantry",
          note: null,
          quantity: 2,
          status: null,
          title: null,
        },
      },
    ]);
    expect(conflictingTargetResponse.status).toBe(400);
    expect(await conflictingTargetResponse.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "Request validation failed.",
    });
  });

  it("persists mixed initial media before queueing exactly one preprocessing job", async () => {
    const createdKinds: string[] = [];
    const preprocessingCreates: Array<Record<string, unknown>> = [];
    const item = {
      archivedAt: null,
      captureText: "Travel kit",
      id: "item-1",
      images: [],
      placements: [
        {
          container: null,
          containerId: null,
          id: "placement-1",
          location: null,
          locationId: null,
          note: null,
          quantity: 1,
        },
      ],
      searchText: "travel kit",
      title: "Travel kit",
    };
    const transaction = {
      inventoryCaptureSession: { findFirst: async () => null },
      inventoryItem: {
        create: async () => item,
        findUnique: async (input: { select?: unknown }) =>
          input.select
            ? {
                assets: [{ id: "asset-1" }],
                audioNotes: [{ id: "audio-1" }],
                id: "item-1",
                images: [{ id: "image-1" }],
              }
            : { ...item, images: [{ id: "image-1" }] },
      },
      inventoryItemAsset: {
        create: async () => {
          createdKinds.push("asset");
          return {
            id: "asset-1",
            mimeType: "video/mp4",
            originalName: "demo.mp4",
            sizeBytes: 5,
          };
        },
      },
      inventoryItemAudio: {
        create: async () => {
          createdKinds.push("audio");
          return {
            id: "audio-1",
            mimeType: "audio/webm",
            originalName: "note.webm",
            sizeBytes: 5,
          };
        },
      },
      inventoryItemImage: {
        create: async () => {
          createdKinds.push("image");
          return {
            id: "image-1",
            mimeType: "image/jpeg",
            originalName: "front.jpg",
            position: 0,
            sizeBytes: 5,
          };
        },
      },
      inventoryPreprocessingJob: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          preprocessingCreates.push(data);
          return { id: "job-1", status: "QUEUED" };
        },
      },
    } as unknown as Prisma.TransactionClient;
    const handlers = createInventoryItemCaptureRouteHandlers({
      cleanupStoredMedia: async () => {},
      runCommand: async (input) => input.execute(transaction),
      storeMedia: async () => [
        {
          filePath: "/tmp/front.jpg",
          kind: "image",
          mimeType: "image/jpeg",
          originalName: "front.jpg",
          sizeBytes: 5,
        },
        {
          filePath: "/tmp/note.webm",
          kind: "audio",
          mimeType: "audio/webm",
          originalName: "note.webm",
          sizeBytes: 5,
        },
        {
          filePath: "/tmp/demo.mp4",
          kind: "asset",
          mimeType: "video/mp4",
          originalName: "demo.mp4",
          sizeBytes: 5,
        },
      ],
    });

    const response = await handlers.captureItem({
      clientId: "client-1",
      files: [
        new File(["front"], "front.jpg", { type: "image/jpeg" }),
        new File(["audio"], "note.webm", { type: "audio/webm" }),
        new File(["video"], "demo.mp4", { type: "video/mp4" }),
      ],
      idempotencyKey: "capture-mixed-1",
      operation: "captureInventoryItem",
      request: { captureText: "Travel kit" },
    });

    expect(response.media.map(({ kind }) => kind)).toEqual([
      "image",
      "audio",
      "asset",
    ]);
    expect(createdKinds).toEqual(["image", "audio", "asset"]);
    expect(preprocessingCreates).toHaveLength(1);
    expect(preprocessingCreates[0]?.sourceRefs).toEqual([
      { id: "item-1", kind: "item" },
      { id: "image-1", kind: "image" },
      { id: "audio-1", kind: "audio" },
      { id: "asset-1", kind: "asset" },
    ]);
  });

  it("creates direct-location clothing capture atomically", async () => {
    const creates: Array<Record<string, unknown>> = [];
    const transaction = {
      inventoryCaptureSession: { findFirst: async () => null },
      inventoryItem: {
        create: async (input: Record<string, unknown>) => {
          creates.push(input);

          return {
            archivedAt: null,
            captureText: "Navy hoodie",
            id: "item-1",
            images: [],
            placements: [
              {
                container: null,
                containerId: null,
                id: "placement-1",
                location: { id: "location-wardrobe", name: "Wardrobe" },
                locationId: "location-wardrobe",
                note: null,
                quantity: 1,
              },
            ],
            searchText: "navy hoodie wardrobe",
            title: "Navy hoodie",
          };
        },
        findUnique: async () => ({
          assets: [],
          audioNotes: [],
          id: "item-1",
          images: [],
        }),
      },
      inventoryLocation: {
        findUnique: async () => ({
          id: "location-wardrobe",
          kind: "STORAGE",
          name: "Wardrobe",
          normalizedName: "wardrobe",
        }),
      },
      inventoryPreprocessingJob: {
        create: async () => ({ id: "job-1", status: "QUEUED" }),
      },
    } as unknown as Prisma.TransactionClient;
    const handlers = createInventoryItemCaptureRouteHandlers({
      cleanupStoredMedia: async () => {},
      runCommand: async (input) => input.execute(transaction),
      storeMedia: async () => [],
    });

    const response = await handlers.captureItem({
      clientId: "client-1",
      files: [],
      idempotencyKey: "capture-clothing-location-1",
      operation: "captureInventoryItem",
      request: {
        category: "clothing",
        locationId: "location-wardrobe",
        title: "Navy hoodie",
      } as never,
    });

    expect(response.item.placements).toEqual([
      {
        containerId: null,
        label: "Wardrobe",
        locationId: "location-wardrobe",
        locationName: "Wardrobe",
        note: null,
        placementId: "placement-1",
        quantity: 1,
      },
    ]);
    expect(creates).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          category: "clothing",
          clothingProfile: {
            create: {
              attributes: { version: 1 },
            },
          },
          placements: {
            create: {
              containerId: null,
              locationId: "location-wardrobe",
              note: null,
              quantity: 1,
            },
          },
        }),
      }),
    ]);
  });

  it("cleans staged media when capture persistence fails", async () => {
    const stored = {
      filePath: "/tmp/front.jpg",
      kind: "image" as const,
      mimeType: "image/jpeg",
      originalName: "front.jpg",
      sizeBytes: 5,
    };
    const cleanupCalls: unknown[][] = [];
    const transaction = {
      inventoryCaptureSession: { findFirst: async () => null },
      inventoryItem: {
        create: async () => {
          throw new Error("Database write failed.");
        },
      },
    } as unknown as Prisma.TransactionClient;
    const handlers = createInventoryItemCaptureRouteHandlers({
      cleanupStoredMedia: async (media) => {
        cleanupCalls.push(media);
      },
      runCommand: async (input) => input.execute(transaction),
      storeMedia: async () => [stored],
    });

    await expect(
      handlers.captureItem({
        clientId: "client-1",
        files: [new File(["front"], "front.jpg", { type: "image/jpeg" })],
        idempotencyKey: "capture-failure-1",
        operation: "captureInventoryItem",
        request: { title: "Camera" },
      }),
    ).rejects.toThrow("Database write failed.");
    expect(cleanupCalls).toEqual([[stored]]);
  });

  it("includes ordered file identity and bytes in capture idempotency input", async () => {
    const requests: Record<string, unknown>[] = [];
    const response = {
      media: [],
      preprocessingJob: { id: "job-1", status: "QUEUED" as const },
      item: buildInventoryItem(),
    };
    const handlers = createInventoryItemCaptureRouteHandlers({
      cleanupStoredMedia: async () => {},
      runCommand: async (input) => {
        requests.push(input.request);
        return { body: response, kind: "success", status: 201 };
      },
      storeMedia: async () => {
        throw new Error("storeMedia should not run for an idempotent replay");
      },
    });
    const capture = (bytes: string) =>
      handlers.captureItem({
        clientId: "client-1",
        files: [new File([bytes], "front.jpg", { type: "image/jpeg" })],
        idempotencyKey: "capture-fingerprint-1",
        operation: "captureInventoryItem",
        request: { title: " Camera " },
      });

    await capture("first");
    await capture("other");

    const firstFile = (requests[0]?.files as Array<Record<string, unknown>>)[0];
    const changedFile = (requests[1]?.files as Array<Record<string, unknown>>)[0];
    expect(firstFile).toMatchObject({
      name: "front.jpg",
      size: 5,
      type: "image/jpeg",
    });
    expect(firstFile?.contentSha256).not.toBe(changedFile?.contentSha256);
    expect(requests[0]?.metadata).toMatchObject({ title: "Camera" });
  });
});
