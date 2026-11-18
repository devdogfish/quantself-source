import { describe, expect, it } from "bun:test";
import {
  InventoryEnrichmentRetryConflictError,
  retryInventoryEnrichment,
  type InventoryEnrichmentJobRecord,
  type InventoryEnrichmentNewJobRecord,
} from "./inventory-enrichment-service";
import {
  InventoryPreprocessingRetryConflictError,
  InventoryPreprocessingRetryNotAllowedError,
  retryInventoryPreprocessing,
  type InventoryPreprocessingJobRecord,
  type InventoryPreprocessingNewJobRecord,
  type InventoryTextBundle,
} from "./inventory-preprocessing-service";
import type { InventoryItemRecord } from "./inventory-service";

describe("Inventory processing retry commands", () => {
  it("queues preprocessing from current saved evidence", async () => {
    const currentItem = item({
      audioNotes: [{ filePath: "audio.m4a", id: "audio-current" }],
      captureText: "current capture text",
      images: [{ filePath: "image.jpg", id: "image-current" }],
    });
    let queued: InventoryPreprocessingNewJobRecord | undefined;
    const failed = preprocessingJob({
      failureDetail: retryablePreprocessingFailure(),
      sourceRefs: [{ id: "item-1", kind: "item" }],
      status: "FAILED",
    });

    const result = await retryInventoryPreprocessing(
      {
        enqueueInventoryPreprocessingJobs: async (jobs) => {
          queued = jobs[0];
          return [preprocessingJob({ ...jobs[0], id: "retry-pre" })];
        },
        getInventoryItem: async () => currentItem,
        listInventoryPreprocessingJobs: async () => [failed],
      },
      { targetItemId: "item-1" },
    );

    expect(result.id).toBe("retry-pre");
    expect(queued?.sourceRefs).toEqual([
      { id: "item-1", kind: "item" },
      { id: "image-current", kind: "image" },
      { id: "audio-current", kind: "audio" },
    ]);
  });

  it("conflicts instead of duplicating equivalent active preprocessing", async () => {
    const currentItem = item({ images: [{ filePath: "image.jpg", id: "image-1" }] });
    const sourceRefs = [
      { id: "item-1", kind: "item" as const },
      { id: "image-1", kind: "image" as const },
    ];

    await expect(
      retryInventoryPreprocessing(
        {
          enqueueInventoryPreprocessingJobs: async () => [],
          getInventoryItem: async () => currentItem,
          listInventoryPreprocessingJobs: async () => [
            preprocessingJob({ sourceRefs, status: "QUEUED" }),
            preprocessingJob({
              failureDetail: retryablePreprocessingFailure(),
              sourceRefs,
              status: "FAILED",
            }),
          ],
        },
        { targetItemId: "item-1" },
      ),
    ).rejects.toBeInstanceOf(InventoryPreprocessingRetryConflictError);
  });

  it("rejects non-retryable preprocessing failures", async () => {
    await expect(
      retryInventoryPreprocessing(
        {
          enqueueInventoryPreprocessingJobs: async () => [],
          getInventoryItem: async () => item(),
          listInventoryPreprocessingJobs: async () => [
            preprocessingJob({
              failureDetail: {
                ...retryablePreprocessingFailure(),
                retryable: false,
              },
              status: "FAILED",
            }),
          ],
        },
        { targetItemId: "item-1" },
      ),
    ).rejects.toBeInstanceOf(InventoryPreprocessingRetryNotAllowedError);
  });

  it("retries legacy partial preprocessing after Girke authorization recovers", async () => {
    let queued: InventoryPreprocessingNewJobRecord | undefined;

    const result = await retryInventoryPreprocessing(
      {
        enqueueInventoryPreprocessingJobs: async (jobs) => {
          queued = jobs[0];
          return [preprocessingJob({ ...jobs[0], id: "retry-pre" })];
        },
        getInventoryItem: async () => item(),
        listInventoryPreprocessingJobs: async () => [
          preprocessingJob({
            status: "PARTIAL",
            textBundle: bundle({
              failedSteps: [
                {
                  code: "unauthorized",
                  mediaId: "image-1",
                  message: "unauthorized",
                  retryable: false,
                  step: "ocr",
                },
              ],
            }),
          }),
        ],
      },
      { targetItemId: "item-1" },
    );

    expect(result.id).toBe("retry-pre");
    expect(queued).toBeDefined();
  });

  it("queues enrichment from current Item facts and latest Text Bundle", async () => {
    const currentItem = item({ title: "Current title" });
    const textBundle = bundle({ captureText: "current bundle" });
    let queued: InventoryEnrichmentNewJobRecord | undefined;

    const result = await retryInventoryEnrichment(
      {
        enqueueInventoryEnrichmentJobs: async (jobs) => {
          queued = jobs[0];
          return [enrichmentJob({ ...jobs[0], id: "retry-enrich" })];
        },
        getInventoryItem: async () => currentItem,
        listInventoryEnrichmentJobs: async () => [
          enrichmentJob({
            failureDetail: retryableEnrichmentFailure(),
            status: "FAILED",
          }),
        ],
        listInventoryPreprocessingJobs: async () => [
          preprocessingJob({ status: "READY_FOR_ENRICHMENT", textBundle }),
        ],
      },
      { targetItemId: "item-1" },
    );

    expect(result.id).toBe("retry-enrich");
    expect(queued?.inputSnapshot).toMatchObject({
      target: { itemId: "item-1", kind: "ITEM" },
      textBundle: { captureText: "current bundle" },
    });
  });

  it("recovers a completed preprocessing handoff when enrichment never started", async () => {
    const currentItem = item({ title: "Orphaned handoff" });
    const textBundle = bundle({ captureText: "completed preprocessing" });
    let queued: InventoryEnrichmentNewJobRecord | undefined;

    const result = await retryInventoryEnrichment(
      {
        enqueueInventoryEnrichmentJobs: async (jobs) => {
          queued = jobs[0];
          return [enrichmentJob({ ...jobs[0], id: "recovered-enrichment" })];
        },
        getInventoryItem: async () => currentItem,
        listInventoryEnrichmentJobs: async () => [],
        listInventoryPreprocessingJobs: async () => [
          preprocessingJob({ status: "READY_FOR_ENRICHMENT", textBundle }),
        ],
      },
      { targetItemId: "item-1" },
    );

    expect(result.id).toBe("recovered-enrichment");
    expect(queued?.inputSnapshot).toMatchObject({
      target: { itemId: "item-1", kind: "ITEM" },
      textBundle: { captureText: "completed preprocessing" },
    });
  });

  it("conflicts when equivalent enrichment is already queued", async () => {
    const currentItem = item();
    const textBundle = bundle();
    let firstInput: InventoryEnrichmentNewJobRecord | undefined;
    const repository = {
      enqueueInventoryEnrichmentJobs: async (
        jobs: InventoryEnrichmentNewJobRecord[],
      ) => {
        firstInput = jobs[0];
        return [enrichmentJob(jobs[0])];
      },
      getInventoryItem: async () => currentItem,
      listInventoryEnrichmentJobs: async () => [
        enrichmentJob({
          failureDetail: retryableEnrichmentFailure(),
          status: "FAILED" as const,
        }),
      ],
      listInventoryPreprocessingJobs: async () => [
        preprocessingJob({ status: "READY_FOR_ENRICHMENT", textBundle }),
      ],
    };

    await retryInventoryEnrichment(repository, { targetItemId: "item-1" });
    if (!firstInput) throw new Error("Expected retry input.");

    repository.listInventoryEnrichmentJobs = async () => [
      enrichmentJob({ ...firstInput, status: "QUEUED" }),
      enrichmentJob({
        failureDetail: retryableEnrichmentFailure(),
        status: "FAILED",
      }),
    ];

    await expect(
      retryInventoryEnrichment(repository, { targetItemId: "item-1" }),
    ).rejects.toBeInstanceOf(InventoryEnrichmentRetryConflictError);
  });
});

function item(overrides: Partial<InventoryItemRecord> = {}): InventoryItemRecord {
  return {
    acquisitionSource: null,
    aliases: [],
    archivedAt: null,
    assets: [],
    audioNotes: [],
    captureSessionId: null,
    captureText: "capture",
    capturedAt: new Date("2026-08-01T12:00:00.000Z"),
    category: null,
    container: null,
    containerId: null,
    containerLabel: null,
    costCents: null,
    costCurrency: "CAD",
    id: "item-1",
    images: [],
    importance: "MEDIUM",
    kind: "ITEM",
    locationId: null,
    locationName: null,
    metadata: {},
    note: null,
    originLocationId: null,
    originLocationName: null,
    placements: [],
    searchText: "",
    status: "KEEP",
    tags: [],
    title: "Item",
    totalQuantity: 1,
    ...overrides,
  };
}

function preprocessingJob(
  overrides: Partial<InventoryPreprocessingJobRecord> = {},
): InventoryPreprocessingJobRecord {
  const now = new Date("2026-08-01T12:00:00.000Z");
  return {
    attempts: 1,
    claimedAt: null,
    claimedBy: null,
    completedAt: now,
    createdAt: now,
    failureDetail: null,
    id: "pre-1",
    leaseExpiresAt: null,
    maxAttempts: 3,
    sourceRefs: [{ id: "item-1", kind: "item" }],
    status: "FAILED",
    targetItemId: "item-1",
    textBundle: null,
    updatedAt: now,
    ...overrides,
  };
}

function enrichmentJob(
  overrides: Partial<InventoryEnrichmentJobRecord> = {},
): InventoryEnrichmentJobRecord {
  const now = new Date("2026-08-01T12:00:00.000Z");
  return {
    attempts: 1,
    claimedAt: null,
    claimedBy: null,
    createdAt: now,
    decidedAt: now,
    failureDetail: null,
    id: "enrich-1",
    inputFingerprint: "old-fingerprint",
    inputSnapshot: {
      schemaVersion: 1,
      sourceFingerprint: "old-fingerprint",
      target: { imageId: null, itemId: "item-1", kind: "ITEM" },
      textBundle: bundle(),
    },
    kind: "INVENTORY_ITEM_ENRICHMENT",
    leaseExpiresAt: null,
    maxAttempts: 3,
    resultId: null,
    resultPayload: null,
    status: "FAILED",
    targetImageId: null,
    targetItemId: "item-1",
    updatedAt: now,
    ...overrides,
  };
}

function bundle(overrides: Partial<InventoryTextBundle> = {}): InventoryTextBundle {
  return {
    captureText: "capture",
    failedSteps: [],
    item: {
      containerLabel: null,
      containerLocation: null,
      id: "item-1",
      importance: "MEDIUM",
      kind: "ITEM",
      note: null,
      status: "KEEP",
      title: "Item",
    },
    mediaTexts: [],
    schemaVersion: 1,
    sourceRefs: [{ id: "item-1", kind: "item" }],
    ...overrides,
  };
}

function retryablePreprocessingFailure() {
  return {
    attempt: 1,
    failedAt: "2026-08-01T12:00:00.000Z",
    leaseClaimedAt: null,
    message: "Temporary OCR failure.",
    retryable: true,
  };
}

function retryableEnrichmentFailure() {
  return {
    attempt: 1,
    failedAt: "2026-08-01T12:00:00.000Z",
    leaseClaimedAt: "2026-08-01T11:59:00.000Z",
    message: "Temporary enrichment failure.",
    retryable: true,
  };
}
