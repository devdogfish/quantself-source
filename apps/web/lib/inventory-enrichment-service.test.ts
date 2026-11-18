import { describe, expect, test } from "bun:test";
import {
  createCaptureSession,
  createInventoryItem,
  searchInventory,
  type InventoryItemImageRecord,
  type InventoryItemRecord,
  type InventoryLocationRecord,
  type InventoryRepository,
  type InventorySearchFilters,
  type InventorySessionRecord,
} from "../../api/src/inventory-service";
import {
  approveInventoryEnrichmentProposal,
  claimInventoryEnrichmentJobs,
  listInventoryEnrichmentProposals,
  queueInventoryEnrichmentCapture,
  queueInventoryEnrichmentTextBundle,
  rejectInventoryEnrichmentProposal,
  submitInventoryEnrichmentFailure,
  submitInventoryEnrichmentSuccess,
  updateInventoryEnrichmentSettings,
  type InventoryEnrichmentJobRecord,
  type InventoryEnrichmentNewJobRecord,
  type InventoryEnrichmentRepository,
  type InventoryEnrichmentSettingsRecord,
} from "../../api/src/inventory-enrichment-service";

class MemoryInventoryEnrichmentRepository
  implements InventoryRepository, InventoryEnrichmentRepository
{
  private locationCount = 0;
  private sessionCount = 0;
  private itemCount = 0;
  private imageCount = 0;
  private jobCount = 0;
  readonly locations: InventoryLocationRecord[] = [];
  readonly sessions: InventorySessionRecord[] = [];
  readonly items: InventoryItemRecord[] = [];
  readonly jobs: InventoryEnrichmentJobRecord[] = [];
  settings: InventoryEnrichmentSettingsRecord = {
    approvalsRequired: true,
    updatedAt: new Date("2026-06-27T09:00:00.000Z"),
  };

  async upsertLocation(input: {
    name?: string | null;
    kind?: InventoryLocationRecord["kind"];
  }): Promise<InventoryLocationRecord | null> {
    const name = input.name?.trim();

    if (!name) {
      return null;
    }

    const existing = this.locations.find(
      (location) => location.name.toLowerCase() === name.toLowerCase(),
    );

    if (existing) {
      return existing;
    }

    const location: InventoryLocationRecord = {
      id: `location-${++this.locationCount}`,
      name,
      kind: input.kind ?? "OTHER",
    };

    this.locations.push(location);

    return location;
  }

  async upsertCaptureSession(input: {
    id?: string | null;
    label?: string | null;
    defaultOriginLocation: InventoryLocationRecord | null;
    defaultDestinationLocation: InventoryLocationRecord | null;
    defaultContainerLabel?: string | null;
    note?: string | null;
  }): Promise<InventorySessionRecord> {
    const session: InventorySessionRecord = {
      id: input.id || `session-${++this.sessionCount}`,
      label: input.label?.trim() || null,
      defaultOriginLocation: input.defaultOriginLocation,
      defaultDestinationLocation: input.defaultDestinationLocation,
      defaultContainerLabel: input.defaultContainerLabel?.trim() || null,
      note: input.note?.trim() || null,
      startedAt: new Date("2026-06-27T10:00:00.000Z"),
    };
    const existingIndex = this.sessions.findIndex(
      (existingSession) => existingSession.id === session.id,
    );

    if (existingIndex >= 0) {
      this.sessions[existingIndex] = session;
    } else {
      this.sessions.push(session);
    }

    return session;
  }

  async getCaptureSession(id: string): Promise<InventorySessionRecord | null> {
    return this.sessions.find((session) => session.id === id) ?? null;
  }

  async getActiveCaptureSession(): Promise<InventorySessionRecord | null> {
    return this.sessions.at(-1) ?? null;
  }

  async createItem(
    input: Omit<InventoryItemRecord, "id" | "capturedAt">,
  ): Promise<InventoryItemRecord> {
    const item: InventoryItemRecord = {
      ...input,
      id: `item-${++this.itemCount}`,
      images: input.images.map((image) => ({
        ...image,
        id: image.id ?? `image-${++this.imageCount}`,
      })),
      capturedAt: new Date(`2026-06-27T11:0${this.itemCount}:00.000Z`),
    };

    this.items.push(item);

    return item;
  }

  async listRecentItems(limit: number): Promise<InventoryItemRecord[]> {
    return [...this.items]
      .sort(
        (left, right) => right.capturedAt.getTime() - left.capturedAt.getTime(),
      )
      .slice(0, limit);
  }

  async findInventoryItems(
    filters: InventorySearchFilters,
  ): Promise<InventoryItemRecord[]> {
    const container = filters.container?.toLowerCase();
    const location = filters.location?.toLowerCase();

    return this.items.filter((item) => {
      if (filters.status && item.status !== filters.status) {
        return false;
      }

      if (filters.importance && item.importance !== filters.importance) {
        return false;
      }

      if (
        container &&
        !item.containerLabel?.toLowerCase().includes(container)
      ) {
        return false;
      }

      if (
        location &&
        ![item.locationName, item.originLocationName]
          .filter((name): name is string => Boolean(name))
          .some((name) => name.toLowerCase().includes(location))
      ) {
        return false;
      }

      return true;
    });
  }

  async enqueueInventoryEnrichmentJobs(
    jobs: InventoryEnrichmentNewJobRecord[],
  ): Promise<InventoryEnrichmentJobRecord[]> {
    const now = new Date("2026-06-27T11:30:00.000Z");
    const createdJobs = jobs.map((job) => ({
      ...job,
      id: `job-${++this.jobCount}`,
      status: "QUEUED" as const,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }));

    this.jobs.push(...createdJobs);

    return createdJobs;
  }

  async listClaimableInventoryEnrichmentJobs(input: {
    limit: number;
    now: Date;
  }): Promise<InventoryEnrichmentJobRecord[]> {
    return this.jobs
      .filter(
        (job) =>
          job.status === "QUEUED" ||
          (job.status === "CLAIMED" &&
            job.leaseExpiresAt !== null &&
            job.leaseExpiresAt <= input.now),
      )
      .slice(0, input.limit);
  }

  async listInventoryEnrichmentJobs(input?: {
    status?: InventoryEnrichmentJobRecord["status"];
    limit?: number;
    targetItemId?: string;
  }): Promise<InventoryEnrichmentJobRecord[]> {
    return this.jobs
      .filter(
        (job) =>
          (!input?.status || job.status === input.status) &&
          (!input?.targetItemId || job.targetItemId === input.targetItemId),
      )
      .slice(0, input?.limit ?? this.jobs.length);
  }

  async updateInventoryEnrichmentJob(
    job: InventoryEnrichmentJobRecord,
  ): Promise<InventoryEnrichmentJobRecord> {
    const index = this.jobs.findIndex(
      (existingJob) => existingJob.id === job.id,
    );
    this.jobs[index] = job;

    return job;
  }

  async getInventoryEnrichmentJob(
    id: string,
  ): Promise<InventoryEnrichmentJobRecord | null> {
    return this.jobs.find((job) => job.id === id) ?? null;
  }

  async getInventoryEnrichmentSettings(): Promise<InventoryEnrichmentSettingsRecord> {
    return this.settings;
  }

  async updateInventoryEnrichmentSettings(
    settings: InventoryEnrichmentSettingsRecord,
  ): Promise<InventoryEnrichmentSettingsRecord> {
    this.settings = settings;

    return settings;
  }

  async getInventoryItem(id: string): Promise<InventoryItemRecord | null> {
    return this.items.find((item) => item.id === id) ?? null;
  }

  async applyInventoryItemEnrichment(input: {
    itemId: string;
    title: string | null;
    note: string | null;
    status: InventoryItemRecord["status"];
    importance: InventoryItemRecord["importance"];
    acquisitionSource: InventoryItemRecord["acquisitionSource"];
    category: InventoryItemRecord["category"];
    costCents: InventoryItemRecord["costCents"];
    tags: string[];
    aliases: string[];
    searchText: string;
    metadata: Record<string, unknown>;
  }): Promise<InventoryItemRecord> {
    const item = this.items.find(
      (existingItem) => existingItem.id === input.itemId,
    );

    if (!item) {
      throw new Error("Inventory item not found.");
    }

    Object.assign(item, {
      acquisitionSource: input.acquisitionSource,
      category: input.category,
      aliases: input.aliases,
      costCents: input.costCents,
      importance: input.importance,
      metadata: input.metadata,
      note: input.note,
      searchText: input.searchText,
      status: input.status,
      tags: input.tags,
      title: input.title,
    });

    return item;
  }

  async applyInventoryImageEnrichment(input: {
    itemId: string;
    imageId: string;
    caption: string | null;
    ocrText: string | null;
    metadata: Record<string, unknown> | null;
  }): Promise<void> {
    const item = this.items.find(
      (existingItem) => existingItem.id === input.itemId,
    );
    const image = item?.images.find(
      (existingImage) => existingImage.id === input.imageId,
    );

    if (!image) {
      throw new Error("Inventory item image not found.");
    }

    image.caption = input.caption ?? image.caption;
    image.ocrText = input.ocrText ?? image.ocrText;
  }
}

describe("inventory enrichment service", () => {
  test("queues bundle-only item snapshots and rejects secret or path-shaped bundle input", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    const item = await createInventoryItem(repository, {
      captureText: "Passport and charging brick",
      title: "Travel pouch",
    });
    const textBundle = {
      captureText: "Passport and charging brick",
      failedSteps: [],
      item: {
        containerLabel: null,
        containerLocation: null,
        id: item.id,
        importance: "MEDIUM" as const,
        kind: "ITEM" as const,
        note: null,
        status: "UNSURE" as const,
        title: "Travel pouch",
      },
      mediaTexts: [
        {
          mediaId: "image-1",
          ocrLines: ["PASSPORT"],
          ocrText: "PASSPORT",
          provider: "girke" as const,
          providerModel: "tesseract-latin-psm11-gray",
          type: "image" as const,
        },
      ],
      schemaVersion: 1 as const,
      sourceRefs: [
        { id: item.id, kind: "item" as const },
        { id: "image-1", kind: "image" as const },
      ],
    };

    const [job] = await queueInventoryEnrichmentTextBundle(
      repository,
      item,
      textBundle,
    );

    expect(job?.inputSnapshot).toEqual({
      schemaVersion: 1,
      sourceFingerprint: expect.any(String),
      target: {
        imageId: null,
        itemId: item.id,
        kind: "ITEM",
      },
      textBundle,
    });
    expect(job?.inputSnapshot).not.toHaveProperty("deterministicMetadata");
    expect(job?.inputSnapshot).not.toHaveProperty("images");
    expect(job?.inputSnapshot).not.toHaveProperty("item");

    const [urlJob] = await queueInventoryEnrichmentTextBundle(
      repository,
      item,
      {
        ...textBundle,
        item: {
          ...textBundle.item,
          note: "Product reference: https://www.canadiantire.ca/example",
        },
      },
    );

    expect(urlJob?.inputSnapshot).toMatchObject({
      textBundle: {
        item: {
          note: "Product reference: https://www.canadiantire.ca/example",
        },
      },
    });

    await expect(
      queueInventoryEnrichmentTextBundle(repository, item, {
        ...textBundle,
        mediaTexts: [
          {
            ...textBundle.mediaTexts[0]!,
            originalName: "travel-pouch.jpg",
          },
        ] as unknown as typeof textBundle.mediaTexts,
      }),
    ).rejects.toThrow("unsupported raw-media input");

    await expect(
      queueInventoryEnrichmentTextBundle(repository, item, {
        ...textBundle,
        captureText: "storage/inventory-images/travel-pouch.jpg",
      }),
    ).rejects.toThrow("unsupported path, url, or secret-shaped");
  });

  test("queues capture work and gates inventory enrichment behind approval by default", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    const session = await createCaptureSession(repository, {
      originRoom: "Office",
      destinationLocation: "Storage shelf",
      defaultContainerLabel: "Travel pouch",
    });

    const item = await createInventoryItem(repository, {
      captureSessionId: session.id,
      title: "Silver travel pouch",
      images: [
        {
          filePath: "storage/inventory-images/travel-photo.jpg",
          originalName: "travel-photo.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1200,
        } satisfies InventoryItemImageRecord,
      ],
    });

    expect(repository.jobs.map((job) => job.kind)).toEqual([
      "INVENTORY_ITEM_ENRICHMENT",
      "INVENTORY_ITEM_IMAGE_ENRICHMENT",
    ]);

    const claimed = await claimInventoryEnrichmentJobs(repository, {
      limit: 5,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:00:00.000Z"),
      workerId: "enrichment-test",
    });
    const itemJob = claimed.find(
      (job) => job.kind === "INVENTORY_ITEM_ENRICHMENT",
    );
    const imageJob = claimed.find(
      (job) => job.kind === "INVENTORY_ITEM_IMAGE_ENRICHMENT",
    );

    if (!itemJob || !imageJob) {
      throw new Error("Expected item and image inventory enrichment jobs.");
    }

    if (!("images" in itemJob.inputSnapshot)) {
      throw new Error("Expected legacy capture snapshot for item enrichment.");
    }

    expect(itemJob.claimedAt?.toISOString()).toBe("2026-06-27T12:00:00.000Z");
    expect(itemJob.leaseExpiresAt?.toISOString()).toBe(
      "2026-06-27T12:01:00.000Z",
    );
    expect(itemJob.claimedBy).toBe("enrichment-test");
    expect(itemJob.inputSnapshot.target.itemId).toBe(item.id);
    expect(imageJob.inputSnapshot.target).toEqual({
      imageId: "image-1",
      itemId: item.id,
      kind: "IMAGE",
    });
    expect(itemJob.inputSnapshot.images[0]?.mediaUrl).toBe(
      "/api/internal/inventory/enrichment/images/image-1",
    );
    expect(itemJob.inputSnapshot.images[0]).toMatchObject({
      id: "image-1",
      mediaUrl: "/api/internal/inventory/enrichment/images/image-1",
      mimeType: "image/jpeg",
      originalName: "travel-photo.jpg",
      sizeBytes: 1200,
    });
    expect(itemJob.inputSnapshot.images[0]).not.toHaveProperty("filePath");
    expect(JSON.stringify(itemJob.inputSnapshot)).not.toContain(
      "storage/inventory-images",
    );

    await submitInventoryEnrichmentSuccess(repository, {
      jobId: itemJob.id,
      leaseClaimedAt: itemJob.claimedAt,
      resultId: "enrichment-result-1",
      result: {
        aliases: ["Nintendo switch dock cable"],
        category: "electronics",
        metadata: { confidence: 0.91 },
        searchTextAdditions: ["portable console dock"],
        tags: ["gaming"],
      },
      now: new Date("2026-06-27T12:00:30.000Z"),
    });

    expect(
      await searchInventory(repository, { query: "Nintendo switch" }),
    ).toEqual([]);

    const proposals = await listInventoryEnrichmentProposals(repository);
    expect(proposals.map((proposal) => proposal.job.id)).toEqual([itemJob.id]);
    expect(proposals[0]?.diff).toEqual([
      {
        after: "technology",
        before: null,
        field: "category",
      },
      {
        after: ["gaming"],
        before: [],
        field: "tags",
      },
      {
        after: ["Nintendo switch dock cable"],
        before: [],
        field: "aliases",
      },
      {
        after: ["portable console dock"],
        before: [],
        field: "searchTextAdditions",
      },
      {
        after: { confidence: 0.91, resultId: "enrichment-result-1" },
        before: null,
        field: "metadata.enrichment",
      },
    ]);

    await approveInventoryEnrichmentProposal(repository, {
      jobId: itemJob.id,
      now: new Date("2026-06-27T12:04:00.000Z"),
    });

    const approvedResults = await searchInventory(repository, {
      query: "Nintendo switch",
    });

    expect(approvedResults[0]?.id).toBe(item.id);
    expect(approvedResults[0]?.matchFields).toContain("alias");
    expect(repository.items[0]?.metadata.enrichment).toEqual({
      confidence: 0.91,
      resultId: "enrichment-result-1",
    });
  });

  test("stages and applies derived title, note, status, and importance from bundle jobs", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    const item = await createInventoryItem(repository, {
      captureText: "Passport, charger, and travel adapters in a black pouch.",
      importance: "LOW",
      note: "Needs sort",
      status: "UNSURE",
      title: "Black pouch",
    });
    const [job] = await queueInventoryEnrichmentTextBundle(repository, item, {
      captureText: "Passport, charger, and travel adapters in a black pouch.",
      failedSteps: [],
      item: {
        containerLabel: null,
        containerLocation: null,
        id: item.id,
        importance: "LOW",
        kind: "GROUP",
        note: "Needs sort",
        status: "UNSURE",
        title: "Black pouch",
      },
      mediaTexts: [],
      schemaVersion: 1,
      sourceRefs: [{ id: item.id, kind: "item" }],
    });
    const claimedJobs = await claimInventoryEnrichmentJobs(repository, {
      leaseSeconds: 60,
      limit: 5,
      now: new Date("2026-06-27T12:20:00.000Z"),
      workerId: "enrichment-test",
    });
    const claimedJob = claimedJobs.find(
      (candidate) => candidate.id === job?.id,
    );

    expect(claimedJob?.id).toBe(job?.id);

    const pendingJob = await submitInventoryEnrichmentSuccess(repository, {
      jobId: claimedJob?.id ?? "",
      leaseClaimedAt: claimedJob?.claimedAt ?? null,
      result: {
        aliases: ["travel document pouch"],
        acquisitionSource: "gift",
        category: "documents",
        costCents: 1250,
        importance: "HIGH",
        metadata: {
          confidence: 0.94,
          rationale: "OCR text references passport and charger contents.",
        },
        note: "Passport and charging kit stored together.",
        status: "KEEP",
        tags: ["travel", "documents"],
        title: "Passport and charger pouch",
      },
      resultId: "bundle-derived-fields-result-1",
      now: new Date("2026-06-27T12:20:30.000Z"),
    });

    expect(pendingJob.status).toBe("PENDING_APPROVAL");
    expect(
      (await listInventoryEnrichmentProposals(repository))[0]?.diff,
    ).toEqual(
      expect.arrayContaining([
        {
          after: "Passport and charger pouch",
          before: "Black pouch",
          field: "title",
        },
        {
          after: "KEEP",
          before: "UNSURE",
          field: "status",
        },
        {
          after: "HIGH",
          before: "LOW",
          field: "importance",
        },
        {
          after: "Passport and charging kit stored together.",
          before: "Needs sort",
          field: "note",
        },
        {
          after: "gift",
          before: null,
          field: "acquisitionSource",
        },
        {
          after: 1250,
          before: null,
          field: "costCents",
        },
      ]),
    );

    const appliedJob = await approveInventoryEnrichmentProposal(repository, {
      jobId: pendingJob.id,
      now: new Date("2026-06-27T12:21:00.000Z"),
    });

    expect(appliedJob.status).toBe("APPLIED");
    expect(repository.items[0]).toMatchObject({
      acquisitionSource: "gift",
      costCents: 1250,
      importance: "HIGH",
      note: "Passport and charging kit stored together.",
      status: "KEEP",
      title: "Passport and charger pouch",
    });
    expect(
      await searchInventory(repository, { query: "passport charger pouch" }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: item.id,
        }),
      ]),
    );
  });

  test("auto-applies image enrichment and keeps item search text in sync", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await updateInventoryEnrichmentSettings(repository, {
      approvalsRequired: false,
      now: new Date("2026-06-27T09:05:00.000Z"),
    });
    const item = await createInventoryItem(repository, {
      title: "Small black case",
      images: [
        {
          filePath: "storage/inventory-images/case-photo.jpg",
          originalName: "case-photo.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 800,
        },
      ],
    });
    const claimedJobs = await claimInventoryEnrichmentJobs(repository, {
      limit: 5,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:10:00.000Z"),
      workerId: "enrichment-test",
    });
    const imageJob = claimedJobs.find(
      (job) => job.kind === "INVENTORY_ITEM_IMAGE_ENRICHMENT",
    );
    const appliedJob = await submitInventoryEnrichmentSuccess(repository, {
      jobId: imageJob?.id ?? "",
      leaseClaimedAt: imageJob?.claimedAt ?? null,
      resultId: "enrichment-image-result-1",
      result: {
        imageCaption: "orange handheld console dock",
        imageOcrText: "SWITCH HDMI",
        metadata: { confidence: 0.82 },
      },
      now: new Date("2026-06-27T12:10:30.000Z"),
    });

    expect(appliedJob.status).toBe("APPLIED");
    expect(repository.items[0]?.images[0]?.caption).toBe(
      "orange handheld console dock",
    );
    expect(repository.items[0]?.images[0]?.ocrText).toBe("SWITCH HDMI");
    expect(repository.items[0]?.searchText).toContain("switch");
    expect(repository.items[0]?.metadata.enrichmentImages).toEqual({
      "image-1": {
        confidence: 0.82,
        resultId: "enrichment-image-result-1",
      },
    });

    const results = await searchInventory(repository, {
      query: "handheld console",
    });

    expect(results[0]?.id).toBe(item.id);
    expect(results[0]?.matchFields).toContain("photo");
  });

  test("applies later inventory enrichment results using the current approval setting", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await updateInventoryEnrichmentSettings(repository, {
      approvalsRequired: false,
      now: new Date("2026-06-27T09:06:00.000Z"),
    });

    await createInventoryItem(repository, {
      title: "Camera pouch",
    });
    const [autoApplyJob] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:12:00.000Z"),
      workerId: "enrichment-test",
    });
    const autoApplied = await submitInventoryEnrichmentSuccess(repository, {
      jobId: autoApplyJob?.id ?? "",
      leaseClaimedAt: autoApplyJob?.claimedAt ?? null,
      result: {
        aliases: ["travel camera case"],
      },
      resultId: "mode-switch-result-1",
      now: new Date("2026-06-27T12:12:30.000Z"),
    });

    await updateInventoryEnrichmentSettings(repository, {
      approvalsRequired: true,
      now: new Date("2026-06-27T12:13:00.000Z"),
    });

    await createInventoryItem(repository, {
      title: "Game cartridge pouch",
    });
    const claimedJobs = await claimInventoryEnrichmentJobs(repository, {
      limit: 5,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:14:00.000Z"),
      workerId: "enrichment-test",
    });
    const pendingJob = claimedJobs.find(
      (job) =>
        job.kind === "INVENTORY_ITEM_ENRICHMENT" &&
        job.targetItemId !== autoApplyJob?.targetItemId,
    );
    const pendingResult = await submitInventoryEnrichmentSuccess(repository, {
      jobId: pendingJob?.id ?? "",
      leaseClaimedAt: pendingJob?.claimedAt ?? null,
      result: {
        aliases: ["switch game holder"],
      },
      resultId: "mode-switch-result-2",
      now: new Date("2026-06-27T12:14:30.000Z"),
    });

    expect(autoApplied.status).toBe("APPLIED");
    expect(repository.items[0]?.aliases).toContain("travel camera case");
    expect(pendingResult.status).toBe("PENDING_APPROVAL");
    expect(repository.items[1]?.aliases).not.toContain("switch game holder");
  });

  test("auto-applies existing pending proposals when auto-approval is enabled", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await createInventoryItem(repository, {
      title: "Camera pouch",
    });
    const [job] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:12:00.000Z"),
      workerId: "enrichment-test",
    });
    const pending = await submitInventoryEnrichmentSuccess(repository, {
      jobId: job?.id ?? "",
      leaseClaimedAt: job?.claimedAt ?? null,
      result: {
        aliases: ["travel camera case"],
      },
      resultId: "existing-pending-result-1",
      now: new Date("2026-06-27T12:12:30.000Z"),
    });

    await updateInventoryEnrichmentSettings(repository, {
      approvalsRequired: false,
      now: new Date("2026-06-27T12:13:00.000Z"),
    });
    await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:13:01.000Z"),
      workerId: "enrichment-test",
    });

    expect(pending.status).toBe("PENDING_APPROVAL");
    expect(repository.jobs[0]?.status).toBe("APPLIED");
    expect(repository.items[0]?.aliases).toContain("travel camera case");
    expect(await listInventoryEnrichmentProposals(repository)).toEqual([]);
  });

  test("autofills blank structured facts and preserves manual ones during trusted auto-apply", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await updateInventoryEnrichmentSettings(repository, {
      approvalsRequired: false,
      now: new Date("2026-06-27T09:07:00.000Z"),
    });
    const item = await createInventoryItem(repository, {
      title: "Travel pouch",
    });
    const [firstJob] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:15:00.000Z"),
      workerId: "enrichment-test",
    });

    await submitInventoryEnrichmentSuccess(repository, {
      jobId: firstJob?.id ?? "",
      leaseClaimedAt: firstJob?.claimedAt ?? null,
      result: {
        acquisitionSource: "gift",
        category: "documents",
        costCents: 1250,
      },
      resultId: "structured-autofill-result-1",
      now: new Date("2026-06-27T12:15:30.000Z"),
    });
    expect(
      (await searchInventory(repository, { query: "documents" })).map(
        (result) => result.id,
      ),
    ).toEqual([item.id]);
    expect(
      (await searchInventory(repository, { query: "gift" })).map(
        (result) => result.id,
      ),
    ).toEqual([item.id]);
    expect(
      (await searchInventory(repository, { query: "1250" })).map(
        (result) => result.id,
      ),
    ).toEqual([item.id]);
    expect(repository.items[0]).toMatchObject({
      acquisitionSource: "gift",
      category: "documents",
      costCents: 1250,
    });

    repository.items[0] = {
      ...repository.items[0]!,
      acquisitionSource: "work",
      category: "technology",
      costCents: 0,
      searchText:
        "travel pouch unsure medium group technology work cad 0.00 0 cents",
    };

    await queueInventoryEnrichmentCapture(repository, repository.items[0]!);

    const replacementJob = (
      await claimInventoryEnrichmentJobs(repository, {
        limit: 1,
        leaseSeconds: 60,
        now: new Date("2026-06-27T12:16:00.000Z"),
        workerId: "enrichment-test",
      })
    )[0];

    await submitInventoryEnrichmentSuccess(repository, {
      jobId: replacementJob?.id ?? "",
      leaseClaimedAt: replacementJob?.claimedAt ?? null,
      result: {
        category: "documents",
        acquisitionSource: "gift",
        costCents: 1250,
      },
      resultId: "structured-autofill-result-2",
      now: new Date("2026-06-27T12:16:30.000Z"),
    });

    expect(
      (await searchInventory(repository, { query: "technology" })).map(
        (result) => result.id,
      ),
    ).toEqual([item.id]);
    expect(
      (await searchInventory(repository, { query: "work" })).map(
        (result) => result.id,
      ),
    ).toEqual([item.id]);
    expect(await searchInventory(repository, { query: "documents" })).toEqual(
      [],
    );
    expect(await searchInventory(repository, { query: "gift" })).toEqual([]);
    expect(await searchInventory(repository, { query: "1250" })).toEqual([]);
    expect(repository.items[0]).toMatchObject({
      acquisitionSource: "work",
      category: "technology",
      costCents: 0,
    });
  });

  test("preserves manually edited fields and does not restore stale search terms", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await updateInventoryEnrichmentSettings(repository, {
      approvalsRequired: false,
      now: new Date("2026-06-27T09:07:15.000Z"),
    });
    const item = await createInventoryItem(repository, {
      title: "Original item",
    });
    Object.assign(item, {
      title: "Manual travel pouch",
      searchText: "manual travel pouch unsure medium group",
      metadata: {
        ...item.metadata,
        manualFieldLocks: ["title"],
      },
    });

    repository.jobs.length = 0;
    await queueInventoryEnrichmentCapture(repository, item);
    const [job] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:17:00.000Z"),
      workerId: "enrichment-test",
    });

    await submitInventoryEnrichmentSuccess(repository, {
      jobId: job?.id ?? "",
      leaseClaimedAt: job?.claimedAt ?? null,
      result: {
        title: "Obsolete asset filename",
        tags: ["travel"],
      },
      resultId: "manual-lock-result-1",
      now: new Date("2026-06-27T12:17:30.000Z"),
    });

    expect(item.title).toBe("Manual travel pouch");
    expect(item.tags).toContain("travel");
    expect(item.searchText).toContain("manual travel pouch");
    expect(item.searchText).not.toContain("obsolete");
    expect(await searchInventory(repository, { query: "obsolete" })).toEqual(
      [],
    );
  });

  test("keeps search in sync when trusted auto-apply replaces image text", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await updateInventoryEnrichmentSettings(repository, {
      approvalsRequired: false,
      now: new Date("2026-06-27T09:07:30.000Z"),
    });
    const item = await createInventoryItem(repository, {
      title: "Travel pouch",
      images: [
        {
          filePath: "storage/inventory-images/travel-pouch.jpg",
          originalName: "travel-pouch.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 900,
        },
      ],
    });
    const firstClaim = await claimInventoryEnrichmentJobs(repository, {
      limit: 5,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:17:00.000Z"),
      workerId: "enrichment-test",
    });
    const firstImageJob = firstClaim.find(
      (job) => job.kind === "INVENTORY_ITEM_IMAGE_ENRICHMENT",
    );

    await submitInventoryEnrichmentSuccess(repository, {
      jobId: firstImageJob?.id ?? "",
      leaseClaimedAt: firstImageJob?.claimedAt ?? null,
      result: {
        imageCaption: "orange game case",
        imageOcrText: "SWITCH",
      },
      resultId: "image-replace-result-1",
      now: new Date("2026-06-27T12:17:30.000Z"),
    });
    expect(
      (await searchInventory(repository, { query: "orange game" })).map(
        (result) => result.id,
      ),
    ).toEqual([item.id]);

    await queueInventoryEnrichmentCapture(repository, repository.items[0]!);

    const replacementClaim = await claimInventoryEnrichmentJobs(repository, {
      limit: 5,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:18:00.000Z"),
      workerId: "enrichment-test",
    });
    const replacementImageJob = replacementClaim.find(
      (job) =>
        job.kind === "INVENTORY_ITEM_IMAGE_ENRICHMENT" &&
        job.targetItemId === item.id &&
        job.id !== firstImageJob?.id,
    );

    await submitInventoryEnrichmentSuccess(repository, {
      jobId: replacementImageJob?.id ?? "",
      leaseClaimedAt: replacementImageJob?.claimedAt ?? null,
      result: {
        imageCaption: "passport sleeve",
        imageOcrText: "PASSPORT",
      },
      resultId: "image-replace-result-2",
      now: new Date("2026-06-27T12:18:30.000Z"),
    });

    expect(
      (await searchInventory(repository, { query: "passport sleeve" })).map(
        (result) => result.id,
      ),
    ).toEqual([item.id]);
    expect(await searchInventory(repository, { query: "orange game" })).toEqual(
      [],
    );
  });

  test("validates result shape and retries failures up to terminal failure", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await createInventoryItem(repository, {
      title: "Neutral case",
    });
    const [job] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:20:00.000Z"),
      workerId: "enrichment-test",
    });

    await expect(
      submitInventoryEnrichmentSuccess(repository, {
        jobId: job?.id ?? "",
        leaseClaimedAt: job?.claimedAt ?? null,
        result: { confidence: 0.91 },
        resultId: "bad-result-1",
        now: new Date("2026-06-27T12:20:30.000Z"),
      }),
    ).rejects.toThrow("not allowed");

    const requeued = await submitInventoryEnrichmentFailure(repository, {
      jobId: job?.id ?? "",
      leaseClaimedAt: job?.claimedAt ?? null,
      message: "temporary model timeout",
      now: new Date("2026-06-27T12:20:40.000Z"),
      retryable: true,
    });
    expect(requeued.status).toBe("QUEUED");

    const [reclaimedJob] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:23:00.000Z"),
      workerId: "enrichment-test",
    });
    const terminal = await submitInventoryEnrichmentFailure(repository, {
      jobId: job?.id ?? "",
      leaseClaimedAt: reclaimedJob?.claimedAt ?? null,
      message: "schema cannot be processed",
      now: new Date("2026-06-27T12:23:30.000Z"),
      retryable: false,
    });

    expect(terminal.status).toBe("FAILED");
    expect(terminal.failureDetail).toEqual({
      attempt: 2,
      failedAt: "2026-06-27T12:23:30.000Z",
      leaseClaimedAt: "2026-06-27T12:23:00.000Z",
      message: "schema cannot be processed",
      retryable: false,
    });
  });

  test("keeps failure submits idempotent per lease and records failure timing", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await createInventoryItem(repository, {
      title: "Neutral case",
    });
    const [job] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:21:00.000Z"),
      workerId: "enrichment-test",
    });
    const firstFailure = await submitInventoryEnrichmentFailure(repository, {
      jobId: job?.id ?? "",
      leaseClaimedAt: job?.claimedAt ?? null,
      message: "temporary model timeout",
      now: new Date("2026-06-27T12:21:30.000Z"),
      retryable: true,
    });
    const secondFailure = await submitInventoryEnrichmentFailure(repository, {
      jobId: job?.id ?? "",
      leaseClaimedAt: job?.claimedAt ?? null,
      message: "temporary model timeout",
      now: new Date("2026-06-27T12:22:00.000Z"),
      retryable: true,
    });

    expect(firstFailure.status).toBe("QUEUED");
    expect(secondFailure.id).toBe(firstFailure.id);
    expect(secondFailure.status).toBe("QUEUED");
    expect(secondFailure.failureDetail).toEqual({
      attempt: 1,
      failedAt: "2026-06-27T12:21:30.000Z",
      leaseClaimedAt: "2026-06-27T12:21:00.000Z",
      message: "temporary model timeout",
      retryable: true,
    });
  });

  test("rejects stale failure retries after the job is reclaimed", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await createInventoryItem(repository, {
      title: "Neutral case",
    });
    const [firstClaim] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:22:30.000Z"),
      workerId: "enrichment-1",
    });
    await submitInventoryEnrichmentFailure(repository, {
      jobId: firstClaim?.id ?? "",
      leaseClaimedAt: firstClaim?.claimedAt ?? null,
      message: "temporary model timeout",
      now: new Date("2026-06-27T12:23:00.000Z"),
      retryable: true,
    });
    await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:25:00.000Z"),
      workerId: "enrichment-2",
    });

    await expect(
      submitInventoryEnrichmentFailure(repository, {
        jobId: firstClaim?.id ?? "",
        leaseClaimedAt: firstClaim?.claimedAt ?? null,
        message: "temporary model timeout",
        now: new Date("2026-06-27T12:25:30.000Z"),
        retryable: true,
      }),
    ).rejects.toThrow("lease is no longer active");
  });

  test("rejects result fields that do not match the claimed job kind or type", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await createInventoryItem(repository, {
      title: "Neutral case",
    });
    const [job] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:24:00.000Z"),
      workerId: "enrichment-test",
    });

    await expect(
      submitInventoryEnrichmentSuccess(repository, {
        jobId: job?.id ?? "",
        leaseClaimedAt: job?.claimedAt ?? null,
        result: { imageCaption: "not valid for item enrichment" },
        resultId: "wrong-kind-result-1",
        now: new Date("2026-06-27T12:24:10.000Z"),
      }),
    ).rejects.toThrow(
      "Inventory enrichment result field is not allowed for INVENTORY_ITEM_ENRICHMENT: imageCaption",
    );

    await expect(
      submitInventoryEnrichmentSuccess(repository, {
        jobId: job?.id ?? "",
        leaseClaimedAt: job?.claimedAt ?? null,
        result: { category: 42 },
        resultId: "wrong-type-result-1",
        now: new Date("2026-06-27T12:24:20.000Z"),
      }),
    ).rejects.toThrow("Inventory enrichment result category must be a string.");

    await expect(
      submitInventoryEnrichmentSuccess(repository, {
        jobId: job?.id ?? "",
        leaseClaimedAt: job?.claimedAt ?? null,
        result: { category: "misc electronics" },
        resultId: "wrong-category-result-1",
        now: new Date("2026-06-27T12:24:25.000Z"),
      }),
    ).rejects.toThrow(
      "Inventory enrichment result category must be one of food, drink, medical, entertainment, office, sports, clothing, homeopathy, supplement, technology, cosmetics, documents, tools, cleaning, kitchen, household, other.",
    );

    await expect(
      submitInventoryEnrichmentSuccess(repository, {
        jobId: job?.id ?? "",
        leaseClaimedAt: job?.claimedAt ?? null,
        result: { acquisitionSource: "borrowed" },
        resultId: "wrong-acquisition-result-1",
        now: new Date("2026-06-27T12:24:27.000Z"),
      }),
    ).rejects.toThrow(
      "Inventory enrichment result acquisitionSource must be one of online, retail, gift, found, work, secondhand, other.",
    );

    await expect(
      submitInventoryEnrichmentSuccess(repository, {
        jobId: job?.id ?? "",
        leaseClaimedAt: job?.claimedAt ?? null,
        result: { costCents: 12.5 },
        resultId: "wrong-value-result-1",
        now: new Date("2026-06-27T12:24:28.000Z"),
      }),
    ).rejects.toThrow(
      "Inventory enrichment result costCents must be a non-negative integer.",
    );

    await expect(
      submitInventoryEnrichmentSuccess(repository, {
        jobId: job?.id ?? "",
        leaseClaimedAt: job?.claimedAt ?? null,
        result: { aliases: ["travel case", 42] },
        resultId: "wrong-list-result-1",
        now: new Date("2026-06-27T12:24:30.000Z"),
      }),
    ).rejects.toThrow(
      "Inventory enrichment result list fields must be string arrays.",
    );
  });

  test("ignores late failure submits after a proposal is staged", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await createInventoryItem(repository, {
      title: "Travel pouch",
    });
    const [job] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:25:00.000Z"),
      workerId: "enrichment-test",
    });

    const pendingJob = await submitInventoryEnrichmentSuccess(repository, {
      jobId: job?.id ?? "",
      leaseClaimedAt: job?.claimedAt ?? null,
      result: {
        aliases: ["passport pouch"],
        searchTextAdditions: ["travel document"],
      },
      resultId: "pending-result-1",
      now: new Date("2026-06-27T12:25:30.000Z"),
    });
    const lateFailure = await submitInventoryEnrichmentFailure(repository, {
      jobId: pendingJob.id,
      message: "late timeout after success response",
      retryable: false,
      now: new Date("2026-06-27T12:27:00.000Z"),
    });

    expect(lateFailure.status).toBe("PENDING_APPROVAL");
    expect(lateFailure.failureDetail).toBeNull();
    expect(lateFailure.resultPayload?.aliases).toEqual(["passport pouch"]);
    expect(
      (await listInventoryEnrichmentProposals(repository)).map(
        (proposal) => proposal.job.id,
      ),
    ).toEqual([pendingJob.id]);
  });

  test("keeps success idempotent while approval is still pending", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await createInventoryItem(repository, {
      title: "Travel pouch",
    });
    const [job] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:27:30.000Z"),
      workerId: "enrichment-test",
    });
    const result = {
      aliases: ["passport pouch"],
      searchTextAdditions: ["travel document"],
    };
    const firstSubmit = await submitInventoryEnrichmentSuccess(repository, {
      jobId: job?.id ?? "",
      leaseClaimedAt: job?.claimedAt ?? null,
      result,
      resultId: "pending-idempotent-result-1",
      now: new Date("2026-06-27T12:28:00.000Z"),
    });
    const secondSubmit = await submitInventoryEnrichmentSuccess(repository, {
      jobId: job?.id ?? "",
      leaseClaimedAt: job?.claimedAt ?? null,
      result,
      resultId: "pending-idempotent-result-1",
      now: new Date("2026-06-27T12:28:30.000Z"),
    });

    expect(firstSubmit.status).toBe("PENDING_APPROVAL");
    expect(secondSubmit.id).toBe(firstSubmit.id);
    expect(secondSubmit.status).toBe("PENDING_APPROVAL");
    expect(
      (await listInventoryEnrichmentProposals(repository)).map(
        (proposal) => proposal.job.id,
      ),
    ).toEqual([firstSubmit.id]);
  });

  test("filters proposals by item before applying the result limit", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    const firstItem = await createInventoryItem(repository, {
      title: "First item",
    });
    const [firstJob] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:28:40.000Z"),
      workerId: "enrichment-test",
    });
    await submitInventoryEnrichmentSuccess(repository, {
      jobId: firstJob?.id ?? "",
      leaseClaimedAt: firstJob?.claimedAt ?? null,
      result: { title: "First proposed title" },
      resultId: "first-item-proposal",
      now: new Date("2026-06-27T12:28:45.000Z"),
    });

    const secondItem = await createInventoryItem(repository, {
      title: "Second item",
    });
    const [secondJob] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:28:50.000Z"),
      workerId: "enrichment-test",
    });
    await submitInventoryEnrichmentSuccess(repository, {
      jobId: secondJob?.id ?? "",
      leaseClaimedAt: secondJob?.claimedAt ?? null,
      result: { title: "Second proposed title" },
      resultId: "second-item-proposal",
      now: new Date("2026-06-27T12:28:55.000Z"),
    });

    expect(firstItem.id).not.toBe(secondItem.id);
    expect(
      (
        await listInventoryEnrichmentProposals(repository, {
          limit: 1,
          targetItemId: secondItem.id,
        })
      ).map((proposal) => proposal.job.targetItemId),
    ).toEqual([secondItem.id]);
  });

  test("rejects pending proposals without changing search-visible fields", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    const item = await createInventoryItem(repository, {
      title: "Travel pouch",
    });
    const [job] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:29:00.000Z"),
      workerId: "enrichment-test",
    });

    const pendingJob = await submitInventoryEnrichmentSuccess(repository, {
      jobId: job?.id ?? "",
      leaseClaimedAt: job?.claimedAt ?? null,
      result: {
        aliases: ["passport organizer"],
        searchTextAdditions: ["travel documents"],
        tags: ["documents"],
      },
      resultId: "rejected-proposal-result-1",
      now: new Date("2026-06-27T12:29:30.000Z"),
    });
    const rejectedJob = await rejectInventoryEnrichmentProposal(repository, {
      jobId: pendingJob.id,
      now: new Date("2026-06-27T12:31:00.000Z"),
    });

    expect(rejectedJob.status).toBe("REJECTED");
    expect(rejectedJob.decidedAt?.toISOString()).toBe(
      "2026-06-27T12:31:00.000Z",
    );
    expect(
      (await listInventoryEnrichmentProposals(repository)).map(
        (proposal) => proposal.job.id,
      ),
    ).toEqual([]);
    expect(
      await searchInventory(repository, { query: "passport organizer" }),
    ).toEqual([]);
    expect(repository.items[0]).toMatchObject({
      aliases: [],
      id: item.id,
      metadata: expect.not.objectContaining({
        enrichment: expect.anything(),
        enrichmentAppliedAt: expect.anything(),
      }),
      searchText: expect.not.stringContaining("passport organizer"),
      tags: [],
    });
  });

  test("rejects stale claimant submits after an expired lease is recovered", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await updateInventoryEnrichmentSettings(repository, {
      approvalsRequired: false,
      now: new Date("2026-06-27T09:08:00.000Z"),
    });
    await createInventoryItem(repository, {
      title: "Passport pouch",
    });
    const [firstClaim] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:28:00.000Z"),
      workerId: "enrichment-1",
    });
    const [recoveredClaim] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:30:00.000Z"),
      workerId: "enrichment-2",
    });

    await expect(
      submitInventoryEnrichmentSuccess(repository, {
        jobId: firstClaim?.id ?? "",
        leaseClaimedAt: firstClaim?.claimedAt ?? null,
        result: { aliases: ["stale passport pouch"] },
        resultId: "stale-lease-result-1",
        now: new Date("2026-06-27T12:30:30.000Z"),
      }),
    ).rejects.toThrow("lease is no longer active");

    const applied = await submitInventoryEnrichmentSuccess(repository, {
      jobId: recoveredClaim?.id ?? "",
      leaseClaimedAt: recoveredClaim?.claimedAt ?? null,
      result: { aliases: ["passport organizer"] },
      resultId: "recovered-lease-result-1",
      now: new Date("2026-06-27T12:30:40.000Z"),
    });

    expect(applied.status).toBe("APPLIED");
    expect(repository.items[0]?.aliases).toContain("passport organizer");
  });

  test("keeps success idempotent and supersedes stale source snapshots", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await updateInventoryEnrichmentSettings(repository, {
      approvalsRequired: false,
      now: new Date("2026-06-27T09:10:00.000Z"),
    });
    const item = await createInventoryItem(repository, {
      title: "Black pouch",
    });
    const [job] = await claimInventoryEnrichmentJobs(repository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:30:00.000Z"),
      workerId: "enrichment-test",
    });
    const result = {
      aliases: ["passport pouch"],
      searchTextAdditions: ["travel document"],
    };
    const firstSubmit = await submitInventoryEnrichmentSuccess(repository, {
      jobId: job?.id ?? "",
      leaseClaimedAt: job?.claimedAt ?? null,
      result,
      resultId: "idempotent-result-1",
      now: new Date("2026-06-27T12:30:30.000Z"),
    });
    const secondSubmit = await submitInventoryEnrichmentSuccess(repository, {
      jobId: job?.id ?? "",
      leaseClaimedAt: job?.claimedAt ?? null,
      result,
      resultId: "idempotent-result-1",
      now: new Date("2026-06-27T12:32:00.000Z"),
    });

    expect(firstSubmit.status).toBe("APPLIED");
    expect(secondSubmit.id).toBe(firstSubmit.id);
    expect(repository.items[0]?.aliases).toEqual(["passport pouch"]);

    const staleRepository = new MemoryInventoryEnrichmentRepository();
    await createInventoryItem(staleRepository, {
      title: "Camera bag",
    });
    const [staleJob] = await claimInventoryEnrichmentJobs(staleRepository, {
      limit: 1,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:33:00.000Z"),
      workerId: "enrichment-test",
    });
    const staleItem = staleRepository.items.find(
      (candidate) => candidate.id === item.id,
    );
    if (staleItem) {
      staleItem.title = "Edited camera bag";
    }

    const superseded = await submitInventoryEnrichmentSuccess(staleRepository, {
      jobId: staleJob?.id ?? "",
      leaseClaimedAt: staleJob?.claimedAt ?? null,
      result: { aliases: ["stale alias"] },
      resultId: "stale-result-1",
      now: new Date("2026-06-27T12:33:30.000Z"),
    });

    expect(superseded.status).toBe("CANCELLED");
    expect(superseded.resultPayload).toBeNull();
    expect(staleRepository.items[0]?.aliases).toEqual([]);
  });

  test("supersedes stale bundle submits when source fields changed after queueing", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    const item = await createInventoryItem(repository, {
      captureText: "Passport and charger in black pouch",
      title: "Black pouch",
    });
    const [bundleJob] = await queueInventoryEnrichmentTextBundle(
      repository,
      item,
      {
        captureText: "Passport and charger in black pouch",
        failedSteps: [],
        item: {
          containerLabel: null,
          containerLocation: null,
          id: item.id,
          importance: "MEDIUM",
          kind: "GROUP",
          note: null,
          status: "UNSURE",
          title: "Black pouch",
        },
        mediaTexts: [],
        schemaVersion: 1,
        sourceRefs: [{ id: item.id, kind: "item" }],
      },
    );
    const claimedJobs = await claimInventoryEnrichmentJobs(repository, {
      leaseSeconds: 60,
      limit: 5,
      now: new Date("2026-06-27T12:34:00.000Z"),
      workerId: "enrichment-test",
    });
    const claimedJob = claimedJobs.find(
      (candidate) => candidate.id === bundleJob?.id,
    );

    repository.items[0] = {
      ...repository.items[0]!,
      captureText: "Passport, charger, and boarding pass in black pouch",
    };

    const superseded = await submitInventoryEnrichmentSuccess(repository, {
      jobId: claimedJob?.id ?? "",
      leaseClaimedAt: claimedJob?.claimedAt ?? null,
      result: { aliases: ["updated bundle alias"] },
      resultId: "stale-bundle-result-1",
      now: new Date("2026-06-27T12:34:30.000Z"),
    });

    expect(superseded.status).toBe("CANCELLED");
  });

  test("supersedes stale bundle submits when category changed after queueing", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    const item = await createInventoryItem(repository, {
      captureText: "Passport and charger in black pouch",
      title: "Black pouch",
    });
    const [bundleJob] = await queueInventoryEnrichmentTextBundle(
      repository,
      item,
      {
        captureText: "Passport and charger in black pouch",
        failedSteps: [],
        item: {
          containerLabel: null,
          containerLocation: null,
          id: item.id,
          importance: "MEDIUM",
          kind: "GROUP",
          note: null,
          status: "UNSURE",
          title: "Black pouch",
        },
        mediaTexts: [],
        schemaVersion: 1,
        sourceRefs: [{ id: item.id, kind: "item" }],
      },
    );
    const claimedJobs = await claimInventoryEnrichmentJobs(repository, {
      leaseSeconds: 60,
      limit: 5,
      now: new Date("2026-06-27T12:35:00.000Z"),
      workerId: "enrichment-test",
    });
    const claimedJob = claimedJobs.find(
      (candidate) => candidate.id === bundleJob?.id,
    );

    repository.items[0] = {
      ...repository.items[0]!,
      category: "household",
    };

    const superseded = await submitInventoryEnrichmentSuccess(repository, {
      jobId: claimedJob?.id ?? "",
      leaseClaimedAt: claimedJob?.claimedAt ?? null,
      result: { category: "documents" },
      resultId: "stale-category-result-1",
      now: new Date("2026-06-27T12:35:30.000Z"),
    });

    expect(superseded.status).toBe("CANCELLED");
  });

  test("supersedes stale bundle submits when acquisition source or value changed after queueing", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    const item = await createInventoryItem(repository, {
      captureText: "Passport and charger in black pouch",
      title: "Black pouch",
    });
    const [bundleJob] = await queueInventoryEnrichmentTextBundle(
      repository,
      item,
      {
        captureText: "Passport and charger in black pouch",
        failedSteps: [],
        item: {
          containerLabel: null,
          containerLocation: null,
          id: item.id,
          importance: "MEDIUM",
          kind: "GROUP",
          note: null,
          status: "UNSURE",
          title: "Black pouch",
        },
        mediaTexts: [],
        schemaVersion: 1,
        sourceRefs: [{ id: item.id, kind: "item" }],
      },
    );
    const claimedJobs = await claimInventoryEnrichmentJobs(repository, {
      leaseSeconds: 60,
      limit: 5,
      now: new Date("2026-06-27T12:36:00.000Z"),
      workerId: "enrichment-test",
    });
    const claimedJob = claimedJobs.find(
      (candidate) => candidate.id === bundleJob?.id,
    );

    repository.items[0] = {
      ...repository.items[0]!,
      acquisitionSource: "work",
      costCents: 0,
    };

    const superseded = await submitInventoryEnrichmentSuccess(repository, {
      jobId: claimedJob?.id ?? "",
      leaseClaimedAt: claimedJob?.claimedAt ?? null,
      result: {
        acquisitionSource: "gift",
        costCents: 1250,
      },
      resultId: "stale-structured-facts-result-1",
      now: new Date("2026-06-27T12:36:30.000Z"),
    });

    expect(superseded.status).toBe("CANCELLED");
  });

  test("does not stale sibling jobs when only inventory enrichment-derived fields changed", async () => {
    const repository = new MemoryInventoryEnrichmentRepository();
    await updateInventoryEnrichmentSettings(repository, {
      approvalsRequired: false,
      now: new Date("2026-06-27T09:15:00.000Z"),
    });
    const item = await createInventoryItem(repository, {
      title: "Black travel case",
      images: [
        {
          filePath: "storage/inventory-images/travel-case.jpg",
          originalName: "travel-case.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1600,
        },
      ],
    });
    const claimedJobs = await claimInventoryEnrichmentJobs(repository, {
      limit: 5,
      leaseSeconds: 60,
      now: new Date("2026-06-27T12:40:00.000Z"),
      workerId: "enrichment-test",
    });
    const itemJob = claimedJobs.find(
      (job) => job.kind === "INVENTORY_ITEM_ENRICHMENT",
    );
    const imageJob = claimedJobs.find(
      (job) => job.kind === "INVENTORY_ITEM_IMAGE_ENRICHMENT",
    );

    if (!itemJob || !imageJob) {
      throw new Error("Expected item and image inventory enrichment jobs.");
    }

    await submitInventoryEnrichmentSuccess(repository, {
      jobId: itemJob.id,
      leaseClaimedAt: itemJob.claimedAt,
      result: {
        aliases: ["passport organizer"],
        metadata: { confidence: 0.88 },
        searchTextAdditions: ["travel documents"],
      },
      resultId: "derived-item-result-1",
      now: new Date("2026-06-27T12:40:30.000Z"),
    });
    const imageResult = await submitInventoryEnrichmentSuccess(repository, {
      jobId: imageJob.id,
      leaseClaimedAt: imageJob.claimedAt,
      result: {
        imageCaption: "zip case with passport slots",
        imageOcrText: "PASSPORT",
      },
      resultId: "derived-image-result-1",
      now: new Date("2026-06-27T12:40:40.000Z"),
    });

    expect(imageResult.status).toBe("APPLIED");
    expect(repository.items[0]?.id).toBe(item.id);
    expect(repository.items[0]?.images[0]?.caption).toBe(
      "zip case with passport slots",
    );
  });
});
