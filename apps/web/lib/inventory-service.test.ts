import { describe, expect, test } from "bun:test";
import { testContainerVisualPreset } from "@/app/inventory/container-test-fixtures";
import {
  buildInventoryItemSearchTextForContainer,
  buildInventoryItemSearchText,
  createCaptureSession,
  createInventoryContainer as createInventoryContainerService,
  createInventoryItem,
  deleteInventoryContainer,
  deleteInventoryItem,
  listRecentInventoryItems,
  searchInventory,
  updateInventoryItem,
  type CreateInventoryItemInput,
  type InventoryContainerRecord,
  type InventoryContainerSummary,
  type InventoryItemImageRecord,
  type InventoryItemUpdateRecordInput,
  type InventoryItemRecord,
  type InventoryLocationRecord,
  type InventoryRepository,
  type InventorySearchFilters,
  type InventorySessionRecord,
} from "../../api/src/inventory-service";

class MemoryInventoryRepository implements InventoryRepository {
  private containerCount = 0;
  private locationCount = 0;
  private sessionCount = 0;
  private itemCount = 0;
  readonly containers: InventoryContainerRecord[] = [];
  readonly locations: InventoryLocationRecord[] = [];
  readonly sessions: InventorySessionRecord[] = [];
  readonly items: InventoryItemRecord[] = [];

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

  async upsertContainer(input: {
    id?: string | null;
    name: string;
    normalizedName: string;
    referenceId: string;
    location: InventoryLocationRecord | null;
    sizeLiters?: number | null;
    visualPresetKey: string;
    metadata?: Record<string, unknown> | null;
  }): Promise<InventoryContainerRecord> {
    const now = new Date(`2026-06-27T09:0${this.containerCount}:00.000Z`);
    const container: InventoryContainerRecord = {
      id: input.id || `container-${++this.containerCount}`,
      referenceId: input.referenceId,
      name: input.name,
      normalizedName: input.normalizedName,
      locationId: input.location?.id ?? null,
      location: input.location,
      sizeLiters: input.sizeLiters ?? null,
      visualPreset: testContainerVisualPreset,
      visualPresetKey: input.visualPresetKey,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    const existingIndex = this.containers.findIndex(
      (existingContainer) => existingContainer.id === container.id,
    );

    if (existingIndex >= 0) {
      this.containers[existingIndex] = container;
    } else {
      this.containers.push(container);
    }

    return container;
  }

  async getContainer(id: string): Promise<InventoryContainerRecord | null> {
    return this.containers.find((container) => container.id === id) ?? null;
  }

  async listContainers(): Promise<InventoryContainerRecord[]> {
    return [...this.containers].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  async listContainerSummaries(): Promise<InventoryContainerSummary[]> {
    return this.containers.map((container) => {
      const items = this.items.filter((item) => item.containerId === container.id);

      return {
        id: container.id,
        referenceId: container.referenceId,
        name: container.name,
        locationName: container.location?.name ?? null,
        sizeLiters: container.sizeLiters,
        photoFilePath: container.photoFilePath,
        visualPreset: container.visualPreset,
        visualPresetKey: container.visualPresetKey,
        itemCount: items.length,
        sampleImages: items.flatMap((item) =>
          item.images
            .filter((image): image is InventoryItemImageRecord & { id: string } =>
              Boolean(image.id),
            )
            .map((image) => ({
              id: image.id,
              alt: image.caption ?? item.title ?? "Inventory item image",
              caption: image.caption ?? null,
            })),
        ),
        sampleItems: items.map((item) => ({
          audioId: item.audioNotes?.[0]?.id ?? null,
          hasAudio: (item.audioNotes?.length ?? 0) > 0,
          id: item.id,
          imageHeight: item.images[0]?.height ?? null,
          imageId: item.images[0]?.id ?? null,
          imageIds: item.images.flatMap((image) =>
            image.id ? [image.id] : [],
          ),
          imageWidth: item.images[0]?.width ?? null,
          textPreview: item.captureText ?? null,
          title: item.title ?? item.captureText ?? "Untitled inventory item",
        })),
        latestCapturedAt: items[0]?.capturedAt ?? null,
      };
    });
  }

  async listItemsForContainer(id: string): Promise<InventoryItemRecord[]> {
    return this.items.filter((item) => item.containerId === id);
  }

  async deleteContainer(id: string): Promise<void> {
    const index = this.containers.findIndex((container) => container.id === id);

    if (index < 0) {
      return;
    }

    this.containers.splice(index, 1);

    for (const item of this.items) {
      if (item.containerId === id) {
        item.containerId = null;
        item.container = null;
      }
    }

    for (const session of this.sessions) {
      if (session.defaultContainer?.id === id) {
        session.defaultContainer = null;
      }
    }
  }

  async upsertCaptureSession(input: {
    id?: string | null;
    label?: string | null;
    defaultOriginLocation: InventoryLocationRecord | null;
    defaultDestinationLocation: InventoryLocationRecord | null;
    defaultContainer?: InventoryContainerRecord | null;
    defaultContainerLabel?: string | null;
    note?: string | null;
  }): Promise<InventorySessionRecord> {
    const session: InventorySessionRecord = {
      id: input.id || `session-${++this.sessionCount}`,
      label: input.label?.trim() || null,
      defaultOriginLocation: input.defaultOriginLocation,
      defaultDestinationLocation: input.defaultDestinationLocation,
      defaultContainer: input.defaultContainer ?? null,
      defaultContainerLabel: input.defaultContainerLabel?.trim() || null,
      note: input.note?.trim() || null,
      startedAt: new Date(
        input.id
          ? this.sessions.find((session) => session.id === input.id)
              ?.startedAt ?? `2026-06-27T10:0${this.sessionCount}:00.000Z`
          : `2026-06-27T10:0${this.sessionCount}:00.000Z`,
      ),
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
      capturedAt: new Date(`2026-06-27T11:0${this.itemCount}:00.000Z`),
    };

    this.items.push(item);

    return item;
  }

  async getInventoryItem(id: string): Promise<InventoryItemRecord | null> {
    return this.items.find((item) => item.id === id) ?? null;
  }

  async updateItem(
    input: InventoryItemUpdateRecordInput,
  ): Promise<InventoryItemRecord> {
    const item = await this.getInventoryItem(input.id);

    if (!item) {
      throw new Error("Missing inventory item.");
    }

    Object.assign(item, {
      aliases: input.aliases,
      acquisitionSource: input.acquisitionSource,
      captureText: input.captureText,
      category: input.category,
      clothingProfile:
        input.category === "clothing"
          ? (item.clothingProfile ?? {
              attributes: { version: 1 as const },
              createdAt: new Date("2026-06-27T11:59:00.000Z"),
              isDirty: false,
              updatedAt: new Date("2026-06-27T11:59:00.000Z"),
            })
          : null,
      containerId: input.containerId,
      containerLabel: input.containerLabel,
      costCents: input.costCents,
      costCurrency: input.costCurrency,
      importance: input.importance,
      kind: input.kind,
      metadata: input.metadata,
      note: input.note,
      searchText: input.searchText,
      status: input.status,
      tags: input.tags,
      title: input.title,
    });
    item.images = [
      ...item.images.filter(
        (image) => !image.id || !input.removeImageIds.includes(image.id),
      ),
      ...input.addImages,
    ];
    item.audioNotes = [
      ...(item.audioNotes ?? []).filter(
        (audioNote) =>
          !audioNote.id ||
          !input.removeAudioNoteIds.includes(audioNote.id),
      ),
      ...input.addAudioNotes,
    ];
    item.assets = [
      ...(item.assets ?? []).filter(
        (asset) => !asset.id || !input.removeAssetIds.includes(asset.id),
      ),
      ...input.addAssets,
    ];

    return item;
  }

  async deleteItem(id: string): Promise<void> {
    const index = this.items.findIndex((item) => item.id === id);

    if (index >= 0) {
      this.items.splice(index, 1);
    }
  }

  async listRecentItems(limit: number): Promise<InventoryItemRecord[]> {
    return [...this.items]
      .sort((left, right) => right.capturedAt.getTime() - left.capturedAt.getTime())
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

      if (filters.category && item.category !== filters.category) {
        return false;
      }

      if (
        filters.acquisitionSource &&
        item.acquisitionSource !== filters.acquisitionSource
      ) {
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
        ![item.container?.location?.name, item.locationName]
          .filter((name): name is string => Boolean(name))
          .some((name) => name.toLowerCase().includes(location))
      ) {
        return false;
      }

      return true;
    });
  }
}

function createInventoryContainer(
  repository: MemoryInventoryRepository,
  input: Parameters<typeof createInventoryContainerService>[1],
) {
  return createInventoryContainerService(repository, {
    ...input,
    visualPresetKey:
      input.visualPresetKey ?? testContainerVisualPreset.id,
  });
}

describe("inventory service", () => {
  test("requires a managed image for every container", async () => {
    const repository = new MemoryInventoryRepository();

    await expect(
      createInventoryContainerService(repository, {
        name: "Missing image",
      }),
    ).rejects.toThrow("Container image is required");

    await expect(
      createInventoryContainerService(repository, {
        name: "Unknown image",
        visualPresetKey: "not-in-catalog",
      }),
    ).rejects.toThrow("Container image must match the repository catalog");
  });

  test("creates containers and assigns captures by session default container", async () => {
    const repository = new MemoryInventoryRepository();
    const container = await createInventoryContainer(repository, {
      name: "Blue bin 4",
      locationName: "Garage shelf A",
      sizeLiters: 45,
    });
    const session = await createCaptureSession(repository, {
      originRoom: "Office",
      defaultContainerId: container.id,
    });

    const item = await createInventoryItem(repository, {
      audioNotes: [
        {
          filePath: "storage/inventory-audio/switch-dock-cables.m4a",
        },
      ],
      captureSessionId: session.id,
      images: [
        { filePath: "storage/inventory-images/switch-front.jpg" },
        { filePath: "storage/inventory-images/switch-back.jpg" },
      ],
      title: "Switch dock cables",
      status: "KEEP",
    });
    const audioNote = item.audioNotes?.[0];
    const [frontImage, backImage] = item.images;

    if (!audioNote || !frontImage || !backImage) {
      throw new Error("Expected the item media to be created.");
    }

    audioNote.id = "audio-switch-dock-cables";
    frontImage.id = "image-switch-front";
    backImage.id = "image-switch-back";

    expect(container.referenceId).toBe("BIN-0001");
    expect(session.defaultContainer?.id).toBe(container.id);
    expect(item.containerId).toBe(container.id);
    expect(item.containerLabel).toBe("Blue bin 4");
    expect(item.locationName).toBe("Garage shelf A");
    expect(item.searchText).toContain("0001");
    expect(item.searchText).toContain("garage");

    const results = await searchInventory(repository, {
      query: "BIN-0001",
    });

    expect(results[0]?.id).toBe(item.id);
    expect(results[0]?.whereLabel).toBe(
      "Garage shelf A / Blue bin 4 (BIN-0001)",
    );

    const [summary] = await repository.listContainerSummaries();

    expect(summary).toMatchObject({
      id: container.id,
      itemCount: 1,
      locationName: "Garage shelf A",
      name: "Blue bin 4",
      sampleItems: [
        {
          audioId: "audio-switch-dock-cables",
          hasAudio: true,
          imageIds: item.images.map((image) => image.id),
        },
      ],
      sizeLiters: 45,
    });
    expect(
      (await repository.listItemsForContainer(container.id)).map(
        ({ id }) => id,
      ),
    ).toEqual([item.id]);
  });

  test("keeps explicit no-container captures unplaced despite session defaults", async () => {
    const repository = new MemoryInventoryRepository();
    const container = await createInventoryContainer(repository, {
      name: "Blue bin 4",
      locationName: "Garage shelf A",
    });
    const session = await createCaptureSession(repository, {
      defaultContainerId: container.id,
      originRoom: "Office",
    });

    const item = await createInventoryItem(repository, {
      captureSessionId: session.id,
      containerId: null,
      title: "Loose adapter",
    });
    const recentItems = await listRecentInventoryItems(repository, 4);

    expect(item.containerId).toBeNull();
    expect(item.container).toBeNull();
    expect(item.containerLabel).toBeNull();
    expect(item.locationName).toBeNull();
    expect(recentItems[0]?.whereLabel).toBe("Unplaced");
  });

  test("rejects duplicate container names and reference IDs", async () => {
    const repository = new MemoryInventoryRepository();

    await createInventoryContainer(repository, {
      name: "Travel drawer",
      referenceId: "TRV-01",
    });

    await expect(
      createInventoryContainer(repository, {
        name: " travel   drawer ",
      }),
    ).rejects.toThrow("name already exists");
    await expect(
      createInventoryContainer(repository, {
        name: "Travel drawer spare",
        referenceId: "trv-01",
      }),
    ).rejects.toThrow("reference ID already exists");
  });

  test("deletes a container with assigned items and keeps item label history", async () => {
    const repository = new MemoryInventoryRepository();
    const container = await createInventoryContainer(repository, {
      name: "Delete me bin",
      referenceId: "DEL-01",
      locationName: "Office closet",
      sizeLiters: 40,
    });
    const session = await createCaptureSession(repository, {
      defaultContainerId: container.id,
    });
    const item = await createInventoryItem(repository, {
      captureSessionId: session.id,
      title: "Old cables",
    });

    const deletedContainer = await deleteInventoryContainer(repository, {
      id: container.id,
    });

    expect(deletedContainer.id).toBe(container.id);
    expect(await repository.getContainer(container.id)).toBeNull();
    expect(repository.sessions[0]?.defaultContainer).toBeNull();
    expect(item.containerId).toBeNull();
    expect(item.container).toBeNull();
    expect(item.containerLabel).toBe("Delete me bin");

    const results = await searchInventory(repository, {
      container: "Delete me",
    });

    expect(results[0]?.id).toBe(item.id);
    expect(results[0]?.whereLabel).toBe("Unplaced");
  });

  test("rejects delete when the container ID is blank or missing", async () => {
    const repository = new MemoryInventoryRepository();

    await expect(
      deleteInventoryContainer(repository, {
        id: " ",
      }),
    ).rejects.toThrow("Container ID is required.");
    await expect(
      deleteInventoryContainer(repository, {
        id: "missing-container",
      }),
    ).rejects.toThrow("Container was not found.");
  });

  test("saves an item group with session defaults and finds it by use-case alias", async () => {
    const repository = new MemoryInventoryRepository();
    const container = await createInventoryContainer(repository, {
      name: "Blue bin 4",
      locationName: "Storage unit shelf A",
    });
    const session = await createCaptureSession(repository, {
      defaultContainerId: container.id,
      originRoom: "Office",
    });

    const item = await createInventoryItem(repository, {
      captureSessionId: session.id,
      kind: "GROUP",
      title: "HDMI adapters and short cables",
      note: "Useful when I need to connect a laptop to the TV.",
      status: "KEEP",
      importance: "HIGH",
      images: [
        {
          filePath: "storage/inventory-images/hdmi.jpg",
          originalName: "hdmi.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1240,
        },
      ],
    });

    expect(item.originLocationName).toBe("Office");
    expect(item.locationName).toBe("Storage unit shelf A");
    expect(item.containerLabel).toBe("Blue bin 4");
    expect(item.tags.includes("electronics")).toBe(true);
    expect(item.aliases.includes("connect laptop to tv")).toBe(true);
    expect(item.searchText).toContain("blue bin 4");

    const results = await searchInventory(repository, {
      query: "connect laptop to TV",
    });

    expect(results[0]?.id).toBe(item.id);
    expect(results[0]?.whereLabel).toBe(
      "Storage unit shelf A / Blue bin 4 (BIN-0001)",
    );
    expect(results[0]?.matchExplanation).toContain("alias");
    expect(results[0]?.images[0]?.filePath).toBe(
      "storage/inventory-images/hdmi.jpg",
    );
  });

  test("generates deterministic metadata from context and photo text with future hooks", async () => {
    const repository = new MemoryInventoryRepository();
    const container = await createInventoryContainer(repository, {
      name: "Clear pouch",
      locationName: "Media cabinet shelf",
    });
    const session = await createCaptureSession(repository, {
      defaultContainerId: container.id,
      originRoom: "Office",
    });
    const dongleImage = {
      filePath: "storage/inventory-images/silver-dongle.jpg",
      originalName: "unknown-device.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1200,
      caption: "HDMI adapter in a cable pouch",
      ocrText: "USB C to HDMI",
    } satisfies InventoryItemImageRecord;
    const dongleCapture = {
      title: "Silver dongle",
      note: "Works with an external display.",
      status: "KEEP",
      images: [dongleImage],
    } satisfies Omit<CreateInventoryItemInput, "captureSessionId">;

    const item = await createInventoryItem(repository, {
      captureSessionId: session.id,
      ...dongleCapture,
    });

    expect(item.category).toBe("technology");
    expect(item.tags).toEqual(["adapter", "cable", "electronics"]);
    expect(item.aliases).toEqual([
      "connect laptop to tv",
      "display cable",
      "video adapter",
    ]);
    expect(item.searchText.split(" ")).toEqual(
      expect.arrayContaining([
        "silver",
        "dongle",
        "external",
        "display",
        "media",
        "cabinet",
        "clear",
        "pouch",
        "unknown",
        "device",
        "hdmi",
        "adapter",
        "usb",
      ]),
    );
    expect(item.metadata).toEqual({
      futureHooks: {
        embeddings: "searchText",
        enrichment: "metadata.enrichment",
        ocr: "images.ocrText",
        reindexing: "stored inventory fields",
        speechToText: "captureText",
        visionCaption: "images.caption",
      },
      generator: "local-deterministic-v1",
      schemaVersion: 1,
      sourceFields: [
        "title",
        "note",
        "captureText",
        "containerLabel",
        "container.referenceId",
        "container.locationName",
        "images.originalName",
        "images.caption",
        "images.ocrText",
        "audioNotes.originalName",
        "assets.originalName",
      ],
    });

    const repeat = await createInventoryItem(repository, {
      captureSessionId: session.id,
      ...dongleCapture,
      images: [
        {
          ...dongleImage,
          filePath: "storage/inventory-images/silver-dongle-copy.jpg",
        },
      ],
    });

    expect(repeat.metadata).toEqual(item.metadata);

    const results = await searchInventory(repository, {
      query: "connect laptop to TV",
    });

    expect(results[0]?.id).toBe(repeat.id);
    expect(results[0]?.matchFields).toContain("alias");
  });

  test("prefers user category and stores acquisition source and zero value", async () => {
    const repository = new MemoryInventoryRepository();
    const container = await createInventoryContainer(repository, {
      name: "Travel drawer",
      locationName: "Hallway shelf",
    });
    const session = await createCaptureSession(repository, {
      defaultContainerId: container.id,
      originRoom: "Office",
    });

    const item = await createInventoryItem(repository, {
      acquisitionSource: "gift",
      captureSessionId: session.id,
      category: "documents",
      costCents: 0,
      note: "Useful when I need to connect a laptop to the TV.",
      status: "KEEP",
      title: "HDMI adapters and short cables",
    });

    expect(item.category).toBe("documents");
    expect(item.acquisitionSource).toBe("gift");
    expect(item.costCents).toBe(0);
    expect(item.costCurrency).toBe("CAD");
    expect(item.searchText).toContain("documents");
    expect(item.searchText).toContain("gift");
  });

  test("rejects an empty item capture", async () => {
    const repository = new MemoryInventoryRepository();
    const session = await createCaptureSession(repository, {
      originRoom: "Office",
      destinationLocation: "Closet",
      defaultContainerLabel: "Green bin",
    });

    await expect(
      createInventoryItem(repository, {
        captureSessionId: session.id,
        title: " ",
        note: "",
        captureText: "",
        images: [],
        audioNotes: [],
      }),
    ).rejects.toThrow("title, note, capture text, image, or audio note");
  });

  test("updates item fields and arbitrary assets with file cleanup metadata", async () => {
    const repository = new MemoryInventoryRepository();
    const item = await createInventoryItem(repository, {
      title: "Old cable pouch",
      images: [
        {
          filePath: "storage/inventory-images/old.jpg",
          mimeType: "image/jpeg",
          originalName: "old.jpg",
          sizeBytes: 100,
        },
      ],
      audioNotes: [
        {
          filePath: "storage/inventory-audio/old.m4a",
          mimeType: "audio/mp4",
          originalName: "old.m4a",
          sizeBytes: 200,
        },
      ],
      assets: [
        {
          filePath: "storage/inventory-assets/old.pdf",
          mimeType: "application/pdf",
          originalName: "old.pdf",
          sizeBytes: 300,
        },
      ],
    });
    item.images[0]!.id = "image-old";
    item.audioNotes![0]!.id = "audio-old";
    item.assets![0]!.id = "asset-old";

    const result = await updateInventoryItem(repository, {
      id: item.id,
      title: "Travel documents",
      tags: ["important", "paper"],
      removeImageIds: ["image-old"],
      removeAudioNoteIds: ["audio-old"],
      removeAssetIds: ["asset-old"],
      addAssets: [
        {
          filePath: "storage/inventory-assets/passport-scan.zip",
          mimeType: "application/zip",
          originalName: "passport-scan.zip",
          sizeBytes: 400,
        },
      ],
    });

    expect(result.removedFiles).toEqual([
      expect.objectContaining({
        id: "image-old",
        kind: "image",
        filePath: "storage/inventory-images/old.jpg",
      }),
      expect.objectContaining({
        id: "audio-old",
        kind: "audio",
        filePath: "storage/inventory-audio/old.m4a",
      }),
      expect.objectContaining({
        id: "asset-old",
        kind: "asset",
        filePath: "storage/inventory-assets/old.pdf",
      }),
    ]);
    expect(result.item).toMatchObject({
      title: "Travel documents",
      tags: ["important", "paper"],
      images: [],
      audioNotes: [],
      assets: [
        expect.objectContaining({
          mimeType: "application/zip",
          originalName: "passport-scan.zip",
        }),
      ],
    });
    expect(result.item.metadata.manualFieldLocks).toEqual(["tags", "title"]);
    expect(result.item.searchText).toContain("passport");
    expect(result.item.searchText).not.toContain("old");
  });

  test("creates a default Clothing Profile when an Item becomes clothing", async () => {
    const repository = new MemoryInventoryRepository();
    const item = await createInventoryItem(repository, {
      title: "Blue oxford shirt",
    });

    const result = await updateInventoryItem(repository, {
      category: "clothing",
      id: item.id,
    });

    expect(result.item).toMatchObject({
      category: "clothing",
      clothingProfile: {
        attributes: { version: 1 },
        isDirty: false,
      },
      id: item.id,
    });
  });

  test("preserves Remedy Profile terms when Item facts rebuild search text", async () => {
    const repository = new MemoryInventoryRepository();
    const item = await createInventoryItem(repository, {
      category: "homeopathy",
      title: "Arnica montana",
    });
    item.remedyProfile = {
      createdAt: new Date("2026-08-03T09:00:00.000Z"),
      externalReferences: [
        {
          referenceId: "arn",
          source: "oorep",
          url: "https://www.oorep.com/remedy/arn",
        },
      ],
      potencies: ["30C", "200C"],
      registeredByClientId: "research-client",
      selectionSummary: "Bruising after overexertion.",
      substanceId: "substance-remedy",
      updatedAt: new Date("2026-08-03T09:00:00.000Z"),
    };

    const result = await updateInventoryItem(repository, {
      id: item.id,
      title: "Arnica",
    });

    expect(result.item.searchText).toContain("200c");
    expect(result.item.searchText).toContain("bruising after overexertion");
    expect(result.item.searchText).toContain("oorep");
    expect(result.item.searchText).toContain("arn");
    expect(buildInventoryItemSearchText(result.item)).toContain("200c");
    expect(
      buildInventoryItemSearchTextForContainer(result.item, {
        location: null,
        name: "Remedy cabinet",
        referenceId: "BIN-0001",
      }),
    ).toContain("200c");
  });

  test("rejects category changes away from clothing while a Clothing Profile exists", async () => {
    const repository = new MemoryInventoryRepository();
    const item = await createInventoryItem(repository, {
      category: "clothing",
      clothingProfile: {
        attributes: { kind: "shirt", version: 1 },
        createdAt: new Date("2026-07-28T12:00:00.000Z"),
        isDirty: false,
        updatedAt: new Date("2026-07-28T12:00:00.000Z"),
      },
      title: "Blue oxford shirt",
    });

    await expect(
      updateInventoryItem(repository, {
        category: "medical",
        id: item.id,
      }),
    ).rejects.toThrow(
      "Inventory Clothing Profile conflicts with non-clothing category.",
    );
  });

  test("permanently deletes an item and returns every stored file", async () => {
    const repository = new MemoryInventoryRepository();
    const item = await createInventoryItem(repository, {
      title: "Delete me",
      images: [{ filePath: "images/delete.jpg" }],
      audioNotes: [{ filePath: "audio/delete.m4a" }],
      assets: [{ filePath: "assets/delete.bin" }],
    });
    item.images[0]!.id = "image-delete";
    item.audioNotes![0]!.id = "audio-delete";
    item.assets![0]!.id = "asset-delete";

    const result = await deleteInventoryItem(repository, { id: item.id });

    expect(
      result.deletedFiles.map(({ kind, filePath }) => ({ kind, filePath })),
    ).toEqual([
      { kind: "image", filePath: "images/delete.jpg" },
      { kind: "audio", filePath: "audio/delete.m4a" },
      { kind: "asset", filePath: "assets/delete.bin" },
    ]);
    expect(repository.items).toEqual([]);
  });

  test("saves a photo-only group with multiple photos for recent display", async () => {
    const repository = new MemoryInventoryRepository();
    const container = await createInventoryContainer(repository, {
      name: "Photo bin",
      locationName: "Storage shelf",
    });
    const session = await createCaptureSession(repository, {
      defaultContainerId: container.id,
      originRoom: "Closet",
    });

    const item = await createInventoryItem(repository, {
      captureSessionId: session.id,
      kind: "GROUP",
      images: [
        {
          filePath: "storage/inventory-images/group-front.jpg",
          originalName: "group-front.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 2400,
        },
        {
          filePath: "storage/inventory-images/group-detail.png",
          originalName: "group-detail.png",
          mimeType: "image/png",
          sizeBytes: 1800,
        },
      ],
    });

    const recentItems = await listRecentInventoryItems(repository, 8);

    expect(item.title).toBeNull();
    expect(item.note).toBeNull();
    expect(item.images).toHaveLength(2);
    expect(item.images[0]).toMatchObject({
      caption: null,
      filePath: "storage/inventory-images/group-front.jpg",
      ocrText: null,
    });
    expect(recentItems[0]?.id).toBe(item.id);
    expect(recentItems[0]?.whereLabel).toBe(
      "Storage shelf / Photo bin (BIN-0001)",
    );
    expect(recentItems[0]?.images.map((image) => image.filePath)).toEqual([
      "storage/inventory-images/group-front.jpg",
      "storage/inventory-images/group-detail.png",
    ]);
  });

  test("updates session defaults and saves text-only captures", async () => {
    const repository = new MemoryInventoryRepository();
    const firstContainer = await createInventoryContainer(repository, {
      name: "Bin A",
      locationName: "Storage shelf",
    });
    const session = await createCaptureSession(repository, {
      defaultContainerId: firstContainer.id,
      originRoom: "Office",
    });
    const secondContainer = await createInventoryContainer(repository, {
      name: "Bin B",
      locationName: "Garage rack",
    });
    const updatedSession = await createCaptureSession(repository, {
      defaultContainerId: secondContainer.id,
      id: session.id,
      originRoom: "Living room",
    });

    expect(updatedSession.id).toBe(session.id);
    expect(updatedSession.defaultOriginLocation?.name).toBe("Living room");
    expect(updatedSession.defaultDestinationLocation).toBeNull();
    expect(updatedSession.defaultContainer?.id).toBe(secondContainer.id);
    expect(updatedSession.defaultContainerLabel).toBeNull();

    const titleOnly = await createInventoryItem(repository, {
      captureSessionId: updatedSession.id,
      title: "HDMI adapter",
      status: "KEEP",
    });
    const noteOnly = await createInventoryItem(repository, {
      captureSessionId: updatedSession.id,
      note: "Bag of unmarked AV cables",
      status: "DONATE",
    });
    const captureTextOnly = await createInventoryItem(repository, {
      captureSessionId: updatedSession.id,
      captureText: "Passport and charging brick",
      status: "KEEP",
    });

    expect(titleOnly.originLocationName).toBe("Living room");
    expect(titleOnly.locationName).toBe("Garage rack");
    expect(titleOnly.containerLabel).toBe("Bin B");
    expect(noteOnly.title).toBeNull();
    expect(noteOnly.note).toBe("Bag of unmarked AV cables");
    expect(captureTextOnly.note).toBeNull();
    expect(captureTextOnly.captureText).toBe("Passport and charging brick");
    expect(captureTextOnly.searchText).toContain("passport");
    expect(repository.items.map((item) => item.id)).toEqual([
      titleOnly.id,
      noteOnly.id,
      captureTextOnly.id,
    ]);
  });

  test("applies status, importance, container, and location filters", async () => {
    const repository = new MemoryInventoryRepository();
    const clearTote = await createInventoryContainer(repository, {
      name: "Clear tote",
      locationName: "Garage shelf",
    });
    const session = await createCaptureSession(repository, {
      defaultContainerId: clearTote.id,
      originRoom: "Kitchen",
    });
    const trashBag = await createInventoryContainer(repository, {
      name: "Black bag",
      locationName: "Trash staging",
    });

    const keptItem = await createInventoryItem(repository, {
      captureSessionId: session.id,
      title: "Label maker tape",
      note: "Office supplies",
      acquisitionSource: "gift",
      category: "office",
      status: "KEEP",
      importance: "MEDIUM",
    });

    await createInventoryItem(repository, {
      captureSessionId: session.id,
      title: "Old takeout lids",
      status: "TRASH",
      importance: "LOW",
      containerId: trashBag.id,
    });

    const statusResults = await searchInventory(repository, {
      status: "KEEP",
    });
    const importanceResults = await searchInventory(repository, {
      importance: "LOW",
    });
    const containerResults = await searchInventory(repository, {
      container: "black",
    });
    const categoryResults = await searchInventory(repository, {
      category: "office",
    });
    const acquisitionResults = await searchInventory(repository, {
      acquisitionSource: "gift",
    });
    const locationResults = await searchInventory(repository, {
      location: "trash",
    });
    const combinedResults = await searchInventory(repository, {
      query: "label",
      status: "KEEP",
      importance: "MEDIUM",
      container: "clear",
      location: "garage",
    });

    expect(statusResults.map((result) => result.id)).toEqual([keptItem.id]);
    expect(importanceResults.map((result) => result.title)).toEqual([
      "Old takeout lids",
    ]);
    expect(containerResults.map((result) => result.title)).toEqual([
      "Old takeout lids",
    ]);
    expect(categoryResults.map((result) => result.id)).toEqual([keptItem.id]);
    expect(acquisitionResults.map((result) => result.id)).toEqual([keptItem.id]);
    expect(locationResults.map((result) => result.title)).toEqual([
      "Old takeout lids",
    ]);
    expect(combinedResults.map((result) => result.id)).toEqual([keptItem.id]);
  });

  test("searches inventory substrings with filters, reasons, photos, and location-first shape", async () => {
    const repository = new MemoryInventoryRepository();
    const clearTote = await createInventoryContainer(repository, {
      name: "Clear tote",
      locationName: "Garage shelf",
    });
    const session = await createCaptureSession(repository, {
      defaultContainerId: clearTote.id,
      originRoom: "Kitchen",
    });
    const trashBag = await createInventoryContainer(repository, {
      name: "Black bag",
      locationName: "Trash staging",
    });

    const penItem = await createInventoryItem(repository, {
      captureSessionId: session.id,
      title: "Ballpoint pen refills",
      note: "Office drawer supplies",
      status: "KEEP",
      importance: "HIGH",
      images: [
        {
          filePath: "storage/inventory-images/pen-refills.jpg",
          originalName: "pen-refills.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 900,
          caption: "pen refill packs",
        },
      ],
    });
    const pencilItem = await createInventoryItem(repository, {
      captureSessionId: session.id,
      title: "Pencil case",
      note: "School supplies",
      status: "KEEP",
      importance: "LOW",
      containerLabelOverride: "Desk pouch",
    });
    await createInventoryItem(repository, {
      captureSessionId: session.id,
      title: "Old kitchen lids",
      status: "TRASH",
      importance: "LOW",
      containerId: trashBag.id,
    });

    const titleResults = await searchInventory(repository, { query: "pen" });
    const noteResults = await searchInventory(repository, { query: "drawer" });
    const containerResults = await searchInventory(repository, {
      query: "clear",
      container: "clear",
    });
    const destinationResults = await searchInventory(repository, {
      query: "garage",
      location: "garage",
    });
    const originResults = await searchInventory(repository, {
      query: "kitchen",
      location: "kitchen",
    });
    const generatedTextResults = await searchInventory(repository, {
      query: "group",
      status: "KEEP",
      importance: "HIGH",
      container: "clear",
      location: "garage",
    });

    expect(titleResults.map((result) => result.id)).toEqual([
      penItem.id,
      pencilItem.id,
    ]);
    expect(noteResults[0]?.matchFields).toContain("note");
    expect(containerResults[0]?.matchFields).toContain("container");
    expect(destinationResults[0]?.matchFields).toContain("location");
    expect(originResults).toEqual([]);
    expect(generatedTextResults[0]?.id).toBe(penItem.id);
    expect(generatedTextResults[0]?.matchFields).toContain("search text");
    expect(generatedTextResults[0]?.whereLabel).toBe(
      "Garage shelf / Clear tote (BIN-0001)",
    );
    expect(generatedTextResults[0]?.images[0]?.filePath).toBe(
      "storage/inventory-images/pen-refills.jpg",
    );
  });

  test("matches query substrings like Browse", async () => {
    const repository = new MemoryInventoryRepository();
    const phone = await createInventoryItem(repository, {
      title: "My iPhone",
      status: "KEEP",
    });

    const results = await searchInventory(repository, { query: "phone" });

    expect(results.map((result) => result.id)).toEqual([phone.id]);
  });
});
