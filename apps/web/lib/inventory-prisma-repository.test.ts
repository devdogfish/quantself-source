import { afterEach, describe, expect, mock, test } from "bun:test";
import { Prisma } from "@quantself/db/generated/prisma/client";

type InventoryEnrichmentSettingsRow = {
  approvalsRequired: boolean;
  createdAt: Date;
  id: string;
  updatedAt: Date;
};

type InventoryItemImageRow = {
  caption: string | null;
  createdAt: Date;
  filePath: string;
  height: number | null;
  id: string;
  itemId: string;
  metadata: Record<string, unknown>;
  mimeType: string | null;
  ocrText: string | null;
  originalName: string | null;
  position: number;
  sizeBytes: number | null;
  updatedAt: Date;
  width: number | null;
};

type InventoryItemPlacementRow = {
  container:
    | null
    | {
        [key: string]: unknown;
        location: null | {
          id: string;
          name: string;
        };
      };
  containerId: string | null;
  createdAt: Date;
  id: string;
  itemId: string;
  note: string | null;
  quantity: number;
  updatedAt: Date;
};

type InventoryItemAudioRow = {
  createdAt: Date;
  filePath: string;
  id: string;
  itemId: string;
  metadata: Record<string, unknown>;
  mimeType: string | null;
  originalName: string | null;
  sizeBytes: number | null;
  updatedAt: Date;
};

type InventoryItemAssetRow = {
  createdAt: Date;
  filePath: string;
  id: string;
  itemId: string;
  metadata: Record<string, unknown>;
  mimeType: string | null;
  originalName: string | null;
  sizeBytes: number | null;
  updatedAt: Date;
};

type InventoryClothingProfileRow = {
  attributes: { version: 1 };
  createdAt: Date;
  isDirty: boolean;
  itemId: string;
  updatedAt: Date;
};

type InventoryItemRow = {
  acquisitionSource: string | null;
  aliases: string[];
  assets?: InventoryItemAssetRow[];
  audioNotes: InventoryItemAudioRow[];
  captureSession: null | {
    defaultDestinationLocation: null | {
      id: string;
      name: string;
    };
    defaultOriginLocation: null | {
      id: string;
      name: string;
    };
  };
  captureSessionId: string | null;
  captureText: string | null;
  capturedAt: Date;
  category: string | null;
  clothingProfile?: InventoryClothingProfileRow | null;
  containerLabel: string | null;
  costCents: number | null;
  costCurrency: string;
  container: null | {
    [key: string]: unknown;
    location: null | {
      id: string;
      name: string;
    };
  };
  id: string;
  images: InventoryItemImageRow[];
  importance: "HIGH" | "MEDIUM" | "LOW";
  kind: "ITEM" | "GROUP";
  metadata: Record<string, unknown>;
  note: string | null;
  placements: InventoryItemPlacementRow[];
  searchText: string;
  status: "KEEP" | "DONATE" | "TRASH" | "UNSURE";
  tags: string[];
  title: string | null;
  updatedAt: Date;
};

type InventoryPreprocessingJobRow = {
  attempts: number;
  claimedAt: Date | null;
  claimedBy: string | null;
  completedAt: Date | null;
  createdAt: Date;
  failureDetail: Record<string, unknown> | null;
  id: string;
  leaseExpiresAt: Date | null;
  maxAttempts: number;
  sourceRefs: Array<{ id: string; kind: "audio" | "image" | "item" }>;
  status:
    | "FAILED"
    | "NEEDS_REVIEW"
    | "PARTIAL"
    | "PROCESSING"
    | "QUEUED"
    | "READY_FOR_ENRICHMENT";
  targetItemId: string;
  textBundle: Record<string, unknown> | null;
  updatedAt: Date;
};

let settingsRow: InventoryEnrichmentSettingsRow | null = null;
let itemRowCount = 0;
let imageRowCount = 0;
let audioRowCount = 0;
let assetRowCount = 0;
let preprocessingJobRowCount = 0;
let lastInventoryItemFindManyInclude: unknown = null;
let lastInventoryItemFindManyWhere: unknown = null;
let lastInventoryItemCreateData: Record<string, unknown> | null = null;
let lastInventoryEnrichmentJobCreateData: Record<string, unknown> | null = null;
const itemRows: InventoryItemRow[] = [];
const preprocessingJobRows: InventoryPreprocessingJobRow[] = [];

mock.module("@quantself/db", () => ({
  prisma: {
    $transaction: async <T>(operations: Promise<T>[]) => Promise.all(operations),
    inventoryEnrichmentSettings: {
      upsert: async ({
        create,
        update,
        where,
      }: {
        create: Partial<InventoryEnrichmentSettingsRow> & { id: string };
        update: Partial<InventoryEnrichmentSettingsRow>;
        where: { id: string };
      }) => {
        if (settingsRow && settingsRow.id === where.id) {
          settingsRow = {
            ...settingsRow,
            ...update,
          };

          return settingsRow;
        }

        const now = new Date("2026-06-27T12:00:00.000Z");
        settingsRow = {
          approvalsRequired: create.approvalsRequired ?? true,
          createdAt: create.createdAt ?? now,
          id: create.id,
          updatedAt: create.updatedAt ?? now,
        };

        return settingsRow;
      },
    },
    inventoryEnrichmentJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        lastInventoryEnrichmentJobCreateData = data;
        const now = new Date("2026-06-27T12:00:00.000Z");

        return {
          ...data,
          attempts: 0,
          createdAt: now,
          failureDetail: null,
          id: "enrichment-job-1",
          resultPayload: null,
          status: "QUEUED",
          updatedAt: now,
        };
      },
    },
    inventoryItem: {
      create: async ({
        data,
      }: {
        data: {
          aliases: string[];
          audioNotes?:
            | {
                create: Array<{
                  filePath: string;
                  metadata: Record<string, unknown>;
                  mimeType: string | null;
                  originalName: string | null;
                  sizeBytes: number | null;
                }>;
              }
            | undefined;
          assets?:
            | {
                create: Array<{
                  filePath: string;
                  metadata: Record<string, unknown>;
                  mimeType: string | null;
                  originalName: string | null;
                  sizeBytes: number | null;
                }>;
              }
            | undefined;
          captureSessionId: string | null;
          captureText: string | null;
          category: string | null;
          containerLabel?: string | null;
          acquisitionSource: string | null;
          costCents: number | null;
          costCurrency: string;
          images?:
            | {
                create: Array<{
                  caption: string | null;
                  filePath: string;
                  height: number | null;
                  metadata: Record<string, unknown>;
                  mimeType: string | null;
                  ocrText: string | null;
                  originalName: string | null;
                  position: number;
                  sizeBytes: number | null;
                  width: number | null;
                }>;
              }
            | undefined;
          placements?: {
            create: {
              containerId: string | null;
              note: string | null;
              quantity: number;
            };
          };
          importance: InventoryItemRow["importance"];
          kind: InventoryItemRow["kind"];
          metadata: Record<string, unknown>;
          note: string | null;
          searchText: string;
          status: InventoryItemRow["status"];
          tags: string[];
          title: string | null;
        };
        include: unknown;
      }) => {
        lastInventoryItemCreateData = data;
        const capturedAt = new Date(
          `2026-06-27T11:0${itemRowCount + 1}:00.000Z`,
        );
        const updatedAt = capturedAt;
        const itemId = `item-${++itemRowCount}`;
        const images = (data.images?.create ?? []).map((image) => ({
          ...image,
          createdAt: capturedAt,
          id: `image-${++imageRowCount}`,
          itemId,
          updatedAt,
        }));
        const audioNotes = (data.audioNotes?.create ?? []).map((audioNote) => ({
          ...audioNote,
          createdAt: capturedAt,
          id: `audio-${++audioRowCount}`,
          itemId,
          updatedAt,
        }));
        const assets = (data.assets?.create ?? []).map((asset) => ({
          ...asset,
          createdAt: capturedAt,
          id: `asset-${++assetRowCount}`,
          itemId,
          updatedAt,
        }));
        const placements: InventoryItemPlacementRow[] = data.placements
          ? [
              {
                ...data.placements.create,
                container: null,
                createdAt: capturedAt,
                id: `placement-${itemId}`,
                itemId,
                updatedAt,
              },
            ]
          : [];
        const itemRow: InventoryItemRow = {
          acquisitionSource: data.acquisitionSource,
          aliases: data.aliases,
          audioNotes,
          assets,
          captureSession: null,
          captureSessionId: data.captureSessionId,
          captureText: data.captureText,
          capturedAt,
          category: data.category,
          containerLabel: data.containerLabel ?? null,
          costCents: data.costCents,
          costCurrency: data.costCurrency,
          container: null,
          id: itemId,
          images,
          importance: data.importance,
          kind: data.kind,
          metadata: data.metadata,
          note: data.note,
          placements,
          searchText: data.searchText,
          status: data.status,
          tags: data.tags,
          title: data.title,
          updatedAt,
        };

        itemRows.push(itemRow);

        return itemRow;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const index = itemRows.findIndex((row) => row.id === where.id);

        if (index < 0) {
          throw new Error("Missing inventory item row.");
        }

        return itemRows.splice(index, 1)[0];
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        itemRows.find((row) => row.id === where.id) ?? null,
      findMany: async ({
        include,
        orderBy,
        take,
        where,
      }: {
        include: unknown;
        orderBy: { capturedAt: "desc" };
        take: number;
        where?: unknown;
      }) => {
        lastInventoryItemFindManyInclude = include;
        lastInventoryItemFindManyWhere = where;
        void orderBy;

        return [...itemRows].slice(0, take);
      },
      update: async ({
        data,
        where,
      }: {
        data: Record<string, unknown> & {
          assets?: {
            create?: Array<
              Omit<InventoryItemAssetRow, "createdAt" | "id" | "itemId" | "updatedAt">
            >;
            deleteMany?: { id: { in: string[] } };
          };
          audioNotes?: {
            create?: Array<
              Omit<InventoryItemAudioRow, "createdAt" | "id" | "itemId" | "updatedAt">
            >;
            deleteMany?: { id: { in: string[] } };
          };
          images?: {
            create?: Array<
              Omit<InventoryItemImageRow, "createdAt" | "id" | "itemId" | "updatedAt">
            >;
            deleteMany?: { id: { in: string[] } };
          };
        };
        where: { id: string };
      }) => {
        const row = itemRows.find((candidate) => candidate.id === where.id);

        if (!row) {
          throw new Error("Missing inventory item row.");
        }

        const now = new Date("2026-06-27T14:00:00.000Z");
        const {
          assets,
          audioNotes,
          clothingProfile,
          images,
          ...scalarData
        } = data;
        Object.assign(row, scalarData, { updatedAt: now });
        if (clothingProfile) {
          row.clothingProfile ??= {
            attributes: { version: 1 },
            createdAt: now,
            isDirty: false,
            itemId: row.id,
            updatedAt: now,
          };
        }
        row.images = row.images.filter(
          ({ id }) => !images?.deleteMany?.id.in.includes(id),
        );
        row.images.push(
          ...(images?.create ?? []).map((image) => ({
            ...image,
            createdAt: now,
            id: `image-${++imageRowCount}`,
            itemId: row.id,
            updatedAt: now,
          })),
        );
        row.audioNotes = row.audioNotes.filter(
          ({ id }) => !audioNotes?.deleteMany?.id.in.includes(id),
        );
        row.audioNotes.push(
          ...(audioNotes?.create ?? []).map((audioNote) => ({
            ...audioNote,
            createdAt: now,
            id: `audio-${++audioRowCount}`,
            itemId: row.id,
            updatedAt: now,
          })),
        );
        row.assets = (row.assets ?? []).filter(
          ({ id }) => !assets?.deleteMany?.id.in.includes(id),
        );
        row.assets.push(
          ...(assets?.create ?? []).map((asset) => ({
            ...asset,
            createdAt: now,
            id: `asset-${++assetRowCount}`,
            itemId: row.id,
            updatedAt: now,
          })),
        );

        return row;
      },
    },
    inventoryItemAsset: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        itemRows
          .flatMap((row) => row.assets ?? [])
          .find((asset) => asset.id === where.id) ?? null,
    },
    inventoryPreprocessingJob: {
      create: async ({
        data,
      }: {
        data: {
          claimedAt: Date | null;
          claimedBy: string | null;
          completedAt?: Date | null;
          failureDetail?: Record<string, unknown> | null;
          leaseExpiresAt: Date | null;
          maxAttempts: number;
          sourceRefs: InventoryPreprocessingJobRow["sourceRefs"];
          targetItemId: string;
          textBundle?: Record<string, unknown> | null;
        };
      }) => {
        const createdAt = new Date(
          `2026-06-27T11:3${preprocessingJobRowCount}:00.000Z`,
        );
        const row: InventoryPreprocessingJobRow = {
          attempts: 0,
          claimedAt: data.claimedAt,
          claimedBy: data.claimedBy,
          completedAt: data.completedAt ?? null,
          createdAt,
          failureDetail: data.failureDetail ?? null,
          id: `preprocessing-job-${++preprocessingJobRowCount}`,
          leaseExpiresAt: data.leaseExpiresAt,
          maxAttempts: data.maxAttempts,
          sourceRefs: data.sourceRefs,
          status: "QUEUED",
          targetItemId: data.targetItemId,
          textBundle: data.textBundle ?? null,
          updatedAt: createdAt,
        };

        preprocessingJobRows.push(row);

        return row;
      },
      findMany: async ({
        orderBy,
        take,
        where,
      }: {
        orderBy: { createdAt?: "asc"; updatedAt?: "desc" };
        take: number;
        where?:
          | {
              OR?: Array<{
                leaseExpiresAt?: { lte: Date };
                status?: InventoryPreprocessingJobRow["status"];
              }>;
              status?: InventoryPreprocessingJobRow["status"];
            }
          | undefined;
      }) => {
        let rows = [...preprocessingJobRows];

        if (where?.OR) {
          rows = rows.filter((row) =>
            where.OR?.some((entry) => {
              if (entry.status && row.status !== entry.status) {
                return false;
              }

              if (entry.leaseExpiresAt?.lte) {
                return (
                  row.leaseExpiresAt !== null &&
                  row.leaseExpiresAt <= entry.leaseExpiresAt.lte
                );
              }

              return true;
            }),
          );
        }

        if (where?.status) {
          rows = rows.filter((row) => row.status === where.status);
        }

        if (orderBy.createdAt === "asc") {
          rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
        }

        if (orderBy.updatedAt === "desc") {
          rows.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
        }

        return rows.slice(0, take);
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        preprocessingJobRows.find((row) => row.id === where.id) ?? null,
      update: async ({
        data,
        where,
      }: {
        data: {
          attempts: number;
          claimedAt: Date | null;
          claimedBy: string | null;
          completedAt: Date | null;
          failureDetail: Record<string, unknown> | null;
          leaseExpiresAt: Date | null;
          maxAttempts: number;
          sourceRefs: InventoryPreprocessingJobRow["sourceRefs"];
          status: InventoryPreprocessingJobRow["status"];
          targetItemId: string;
          textBundle: Record<string, unknown> | null;
          updatedAt: Date;
        };
        where: { id: string };
      }) => {
        const row = preprocessingJobRows.find((candidate) => candidate.id === where.id);

        if (!row) {
          throw new Error("Missing preprocessing job row.");
        }

        Object.assign(row, data);

        return row;
      },
    },
  },
}));

afterEach(() => {
  settingsRow = null;
  itemRowCount = 0;
  imageRowCount = 0;
  audioRowCount = 0;
  assetRowCount = 0;
  preprocessingJobRowCount = 0;
  lastInventoryItemFindManyInclude = null;
  lastInventoryItemFindManyWhere = null;
  lastInventoryItemCreateData = null;
  lastInventoryEnrichmentJobCreateData = null;
  itemRows.length = 0;
  preprocessingJobRows.length = 0;
});

describe("inventory prisma repository", () => {
  test("prefilters searches with the shared substring terms", async () => {
    const { inventoryRepository } =
      await import("../../api/src/inventory-prisma-repository");

    await inventoryRepository.findInventoryItems({
      query: "phone office",
    });

    const where = lastInventoryItemFindManyWhere as {
      AND: Array<{
        AND: Array<{
          OR: Array<{
            searchText?: {
              contains: string;
              mode: string;
            };
          }>;
        }>;
      }>;
      archivedAt: null;
    };
    const queryTerms = where.AND[0]?.AND.map(
      (term) => term.OR[0]?.searchText,
    );

    expect(where.archivedAt).toBeNull();
    expect(queryTerms).toEqual([
      { contains: "phone", mode: "insensitive" },
      { contains: "office", mode: "insensitive" },
    ]);
  });

  test("lists the repository catalog in stable order with one default", async () => {
    const { inventoryRepository } =
      await import("../../api/src/inventory-prisma-repository");

    const catalog = await inventoryRepository.listContainerVisualPresets();

    expect(catalog.map(({ id }) => id)).toEqual(["6L", "39L", "80L"]);
    expect(catalog.filter(({ isDefault }) => isDefault).map(({ id }) => id)).toEqual([
      "6L",
    ]);
    expect(catalog[1]).toMatchObject({
      frontImageUrl: "/inventory/container-visual-catalog/39l/front.webp",
      height: 857,
      id: "39L",
      width: 1456,
    });
  });

  test(
    "defaults inventory enrichment approval settings on and persists updates",
    async () => {
      const { inventoryRepository } =
        await import("../../api/src/inventory-prisma-repository");

      const defaultSettings =
        await inventoryRepository.getInventoryEnrichmentSettings();

      expect(defaultSettings.approvalsRequired).toBe(true);

      const updatedAt = new Date("2026-06-27T13:00:00.000Z");
      const updatedSettings =
        await inventoryRepository.updateInventoryEnrichmentSettings({
          approvalsRequired: false,
          updatedAt,
        });

      expect(updatedSettings.approvalsRequired).toBe(false);
      expect(updatedSettings.updatedAt.toISOString()).toBe(
        updatedAt.toISOString(),
      );

      const persistedSettings =
        await inventoryRepository.getInventoryEnrichmentSettings();

      expect(persistedSettings.approvalsRequired).toBe(false);
      expect(persistedSettings.updatedAt.toISOString()).toBe(
        updatedAt.toISOString(),
      );
    },
  );

  test("persists nullable enrichment JSON fields as database nulls", async () => {
    const { inventoryRepository } =
      await import("../../api/src/inventory-prisma-repository");

    await inventoryRepository.enqueueInventoryEnrichmentJobs([
      {
        claimedAt: null,
        claimedBy: null,
        decidedAt: null,
        failureDetail: null,
        inputFingerprint: "fingerprint-1",
        inputSnapshot: {
          deterministicMetadata: {
            aliases: [],
            category: null,
            metadata: {},
            searchText: "fillet knife rapala",
            tags: [],
          },
          images: [],
          item: {
            capturedAt: "2026-06-27T11:00:00.000Z",
            containerLabel: null,
            captureText: "Fillet knife",
            id: "item-1",
            importance: "MEDIUM",
            kind: "ITEM",
            locationName: null,
            note: null,
            originLocationName: null,
            status: "KEEP",
            title: "Rapala knife",
          },
          schemaVersion: 1,
          sourceFingerprint: "fingerprint-1",
          target: { imageId: null, itemId: "item-1", kind: "ITEM" },
        },
        kind: "INVENTORY_ITEM_ENRICHMENT",
        leaseExpiresAt: null,
        maxAttempts: 3,
        resultId: null,
        resultPayload: null,
        targetImageId: null,
        targetItemId: "item-1",
      },
    ]);

    expect(lastInventoryEnrichmentJobCreateData?.failureDetail).toBe(
      Prisma.DbNull,
    );
    expect(lastInventoryEnrichmentJobCreateData?.resultPayload).toBe(
      Prisma.DbNull,
    );
  });

  test(
    "persists capture text, audio notes, and preprocessing jobs with queued defaults",
    async () => {
      const { inventoryRepository } =
        await import("../../api/src/inventory-prisma-repository");

      const item = await inventoryRepository.createItem({
        acquisitionSource: "gift",
        aliases: [],
        assets: [
          {
            filePath: "storage/inventory-assets/passport.pdf",
            mimeType: "application/pdf",
            originalName: "passport.pdf",
            sizeBytes: 4096,
          },
        ],
        audioNotes: [
          {
            filePath: "storage/inventory-audio/travel-note.m4a",
            mimeType: "audio/mp4",
            originalName: "travel-note.m4a",
            sizeBytes: 2048,
          },
        ],
        captureSessionId: null,
        captureText: "Passport and charging brick",
        category: "documents",
        containerLabel: "Travel pouch",
        costCents: 0,
        costCurrency: "CAD",
        images: [
          {
            filePath: "storage/inventory-images/travel-pouch.jpg",
            mimeType: "image/jpeg",
            originalName: "travel-pouch.jpg",
            sizeBytes: 1024,
          },
        ],
        importance: "MEDIUM",
        kind: "ITEM",
        locationId: null,
        locationName: null,
        metadata: {},
        note: null,
        originLocationId: null,
        originLocationName: null,
        searchText: "passport charging brick travel pouch",
        status: "KEEP",
        tags: [],
        title: "Silver travel pouch",
      });

      expect(item.captureText).toBe("Passport and charging brick");
      expect(item.category).toBe("documents");
      expect(item.acquisitionSource).toBe("gift");
      expect(item.costCents).toBe(0);
      expect(item.costCurrency).toBe("CAD");
      expect(item.images[0]).toMatchObject({
        id: "image-1",
        originalName: "travel-pouch.jpg",
      });
      expect(item.audioNotes).toEqual([
        expect.objectContaining({
          filePath: "storage/inventory-audio/travel-note.m4a",
          id: "audio-1",
          originalName: "travel-note.m4a",
        }),
      ]);
      expect(item.assets).toEqual([
        expect.objectContaining({
          filePath: "storage/inventory-assets/passport.pdf",
          id: "asset-1",
          mimeType: "application/pdf",
          originalName: "passport.pdf",
        }),
      ]);
      expect(lastInventoryItemCreateData).toMatchObject({
        acquisitionSource: "gift",
        category: "documents",
        costCents: 0,
        costCurrency: "CAD",
      });
      expect(lastInventoryItemCreateData).not.toHaveProperty("originLocationId");
      expect(lastInventoryItemCreateData).not.toHaveProperty("locationId");

      const [job] = await inventoryRepository.enqueueInventoryPreprocessingJobs([
        {
          claimedAt: null,
          claimedBy: null,
          leaseExpiresAt: null,
          maxAttempts: 3,
          sourceRefs: [
            { id: item.id, kind: "item" },
            { id: "image-1", kind: "image" },
            { id: "audio-1", kind: "audio" },
          ],
          targetItemId: item.id,
        },
      ]);

      expect(job).toMatchObject({
        attempts: 0,
        completedAt: null,
        failureDetail: null,
        sourceRefs: [
          { id: item.id, kind: "item" },
          { id: "image-1", kind: "image" },
          { id: "audio-1", kind: "audio" },
        ],
        status: "QUEUED",
        targetItemId: item.id,
        textBundle: null,
      });

      const claimableJobs =
        await inventoryRepository.listClaimableInventoryPreprocessingJobs({
          limit: 5,
          now: new Date("2026-06-27T12:00:00.000Z"),
        });

      expect(claimableJobs.map((claimableJob) => claimableJob.id)).toEqual([
        job.id,
      ]);

      const updatedJob = await inventoryRepository.updateInventoryPreprocessingJob({
        ...job,
        attempts: 1,
        claimedAt: new Date("2026-06-27T12:00:00.000Z"),
        claimedBy: "preprocessing-test",
        completedAt: new Date("2026-06-27T12:00:30.000Z"),
        failureDetail: null,
        leaseExpiresAt: new Date("2026-06-27T12:01:30.000Z"),
        textBundle: {
          captureText: "Passport and charging brick",
          failedSteps: [],
          item: {
            containerLabel: "Travel pouch",
            containerLocation: null,
            id: item.id,
            importance: "MEDIUM",
            kind: "ITEM",
            note: null,
            status: "KEEP",
            title: "Silver travel pouch",
          },
          mediaTexts: [],
          schemaVersion: 1,
          sourceRefs: [
            { id: item.id, kind: "item" },
            { id: "image-1", kind: "image" },
            { id: "audio-1", kind: "audio" },
          ],
        },
        status: "PROCESSING",
        updatedAt: new Date("2026-06-27T12:00:00.000Z"),
      });

      expect(updatedJob.status).toBe("PROCESSING");
      expect(updatedJob.claimedBy).toBe("preprocessing-test");
      expect(updatedJob.completedAt?.toISOString()).toBe(
        "2026-06-27T12:00:30.000Z",
      );
      expect(updatedJob.textBundle).toEqual({
        captureText: "Passport and charging brick",
        failedSteps: [],
        item: {
          containerLabel: "Travel pouch",
          containerLocation: null,
          id: item.id,
          importance: "MEDIUM",
          kind: "ITEM",
          note: null,
          status: "KEEP",
          title: "Silver travel pouch",
        },
        mediaTexts: [],
        schemaVersion: 1,
        sourceRefs: [
          { id: item.id, kind: "item" },
          { id: "image-1", kind: "image" },
          { id: "audio-1", kind: "audio" },
        ],
      });

      const persistedJob =
        await inventoryRepository.getInventoryPreprocessingJob(job.id);

      expect(persistedJob).toMatchObject({
        attempts: 1,
        completedAt: new Date("2026-06-27T12:00:30.000Z"),
        id: job.id,
        status: "PROCESSING",
        textBundle: {
          captureText: "Passport and charging brick",
          failedSteps: [],
          item: {
            containerLabel: "Travel pouch",
            containerLocation: null,
            id: item.id,
            importance: "MEDIUM",
            kind: "ITEM",
            note: null,
            status: "KEEP",
            title: "Silver travel pouch",
          },
          mediaTexts: [],
          schemaVersion: 1,
          sourceRefs: [
            { id: item.id, kind: "item" },
            { id: "image-1", kind: "image" },
            { id: "audio-1", kind: "audio" },
          ],
        },
      });
    },
  );

  test("updates and deletes items with generic asset relations", async () => {
    const {
      getInventoryAssetFile,
      inventoryRepository,
    } = await import("../../api/src/inventory-prisma-repository");
    const item = await inventoryRepository.createItem({
      acquisitionSource: null,
      aliases: [],
      assets: [
        {
          filePath: "storage/inventory-assets/old.pdf",
          mimeType: "application/pdf",
          originalName: "old.pdf",
          sizeBytes: 300,
        },
      ],
      audioNotes: [],
      captureSessionId: null,
      captureText: null,
      category: "documents",
      containerLabel: null,
      costCents: null,
      costCurrency: "CAD",
      images: [],
      importance: "MEDIUM",
      kind: "ITEM",
      locationId: null,
      locationName: null,
      metadata: {},
      note: null,
      originLocationId: null,
      originLocationName: null,
      searchText: "old pdf",
      status: "KEEP",
      tags: [],
      title: "Old document",
    });

    const updated = await inventoryRepository.updateItem({
      id: item.id,
      acquisitionSource: "retail",
      addAssets: [
        {
          filePath: "storage/inventory-assets/new.bin",
          mimeType: "application/octet-stream",
          originalName: "new.bin",
          sizeBytes: 500,
        },
      ],
      addAudioNotes: [],
      addImages: [],
      aliases: [],
      captureText: null,
      category: "documents",
      containerId: null,
      containerLabel: null,
      costCents: 250,
      costCurrency: "CAD",
      importance: "HIGH",
      kind: "ITEM",
      metadata: { manualFieldLocks: ["title"] },
      note: "Updated",
      removeAssetIds: ["asset-1"],
      removeAudioNoteIds: [],
      removeImageIds: [],
      searchText: "new bin updated",
      status: "KEEP",
      tags: ["documents"],
      title: "New document",
    });

    expect(updated.assets).toEqual([
      expect.objectContaining({
        filePath: "storage/inventory-assets/new.bin",
        id: "asset-2",
      }),
    ]);
    expect(await getInventoryAssetFile("asset-2")).toMatchObject({
      filePath: "storage/inventory-assets/new.bin",
      mimeType: "application/octet-stream",
      originalName: "new.bin",
    });

    const enriched = await inventoryRepository.applyInventoryItemEnrichment({
      acquisitionSource: "gift",
      aliases: ["automatic"],
      category: "technology",
      costCents: 900,
      importance: "LOW",
      itemId: item.id,
      metadata: {
        manualFieldLocks: ["title"],
        enrichment: { confidence: 0.9 },
      },
      note: "Automatic",
      searchText: "new document automatic",
      status: "UNSURE",
      tags: ["automatic"],
      title: "Automatic title",
    });

    expect(enriched.title).toBe("New document");
    expect(enriched.tags).toEqual(["automatic"]);
    expect(enriched.metadata.manualFieldLocks).toEqual(["title"]);

    await inventoryRepository.deleteItem(item.id);

    expect(itemRows).toEqual([]);
    expect(await getInventoryAssetFile("asset-2")).toBeNull();
  });

  test("keeps Clothing Profile agreement during Inventory Enrichment", async () => {
    const { inventoryRepository } =
      await import("../../api/src/inventory-prisma-repository");
    const capturedAt = new Date("2026-06-27T11:00:00.000Z");

    itemRows.push({
      acquisitionSource: null,
      aliases: [],
      assets: [],
      audioNotes: [],
      captureSession: null,
      captureSessionId: null,
      captureText: null,
      capturedAt,
      category: "household",
      clothingProfile: null,
      container: null,
      containerLabel: null,
      costCents: null,
      costCurrency: "CAD",
      id: "item-shirt",
      images: [],
      importance: "MEDIUM",
      kind: "ITEM",
      metadata: {},
      note: null,
      placements: [],
      searchText: "blue shirt",
      status: "KEEP",
      tags: [],
      title: "Blue shirt",
      updatedAt: capturedAt,
    });

    const clothing = await inventoryRepository.applyInventoryItemEnrichment({
      acquisitionSource: null,
      aliases: [],
      category: "clothing",
      costCents: null,
      importance: "MEDIUM",
      itemId: "item-shirt",
      metadata: {},
      note: null,
      searchText: "blue shirt clothing",
      status: "KEEP",
      tags: ["clothing"],
      title: "Blue shirt",
    });

    expect(clothing).toMatchObject({
      category: "clothing",
      clothingProfile: {
        attributes: { version: 1 },
        isDirty: false,
      },
    });

    await expect(
      inventoryRepository.applyInventoryItemEnrichment({
        acquisitionSource: null,
        aliases: [],
        category: "household",
        costCents: null,
        importance: "MEDIUM",
        itemId: "item-shirt",
        metadata: {},
        note: null,
        searchText: "blue shirt",
        status: "KEEP",
        tags: [],
        title: "Blue shirt",
      }),
    ).rejects.toThrow(
      "Inventory Clothing Profile conflicts with non-clothing category.",
    );
    expect(itemRows[0]?.category).toBe("clothing");
  });

  test("lists recent items without deleted item location relations", async () => {
    const { inventoryRepository } =
      await import("../../api/src/inventory-prisma-repository");

    itemRows.push({
      aliases: [],
      audioNotes: [],
      captureSession: {
        defaultDestinationLocation: {
          id: "location-garage-rack",
          name: "Garage rack",
        },
        defaultOriginLocation: {
          id: "location-living-room",
          name: "Living room",
        },
      },
      captureSessionId: "session-1",
      captureText: null,
      capturedAt: new Date("2026-06-27T10:00:00.000Z"),
      category: null,
      containerLabel: "Travel pouch",
      acquisitionSource: null,
      costCents: null,
      costCurrency: "CAD",
      container: {
        createdAt: new Date("2026-06-27T09:00:00.000Z"),
        id: "container-travel-pouch",
        location: {
          id: "location-garage-rack",
          name: "Garage rack",
        },
        locationId: "location-garage-rack",
        metadata: {},
        name: "Travel pouch",
        normalizedName: "travel pouch",
        photoFilePath: null,
        referenceId: "BIN-0001",
        sizeLiters: 12,
        updatedAt: new Date("2026-06-27T09:00:00.000Z"),
        visualPresetKey: "39L",
      },
      id: "item-1",
      images: [],
      importance: "MEDIUM",
      kind: "ITEM",
      metadata: {},
      note: null,
      placements: [
        {
          container: {
            createdAt: new Date("2026-06-27T09:00:00.000Z"),
            id: "container-travel-pouch",
            location: {
              id: "location-garage-rack",
              name: "Garage rack",
            },
            locationId: "location-garage-rack",
            metadata: {},
            name: "Travel pouch",
            normalizedName: "travel pouch",
            photoFilePath: null,
            referenceId: "BIN-0001",
            sizeLiters: 12,
            updatedAt: new Date("2026-06-27T09:00:00.000Z"),
            visualPresetKey: "39L",
          },
          containerId: "container-travel-pouch",
          createdAt: new Date("2026-06-27T10:00:00.000Z"),
          id: "placement-1",
          itemId: "item-1",
          note: null,
          quantity: 1,
          updatedAt: new Date("2026-06-27T10:00:00.000Z"),
        },
      ],
      searchText: "",
      status: "KEEP",
      tags: [],
      title: "Travel pouch",
      updatedAt: new Date("2026-06-27T10:00:00.000Z"),
    });

    const items = await inventoryRepository.listRecentItems(6);

    expect(lastInventoryItemFindManyInclude).toMatchObject({
      captureSession: {
        include: {
          defaultDestinationLocation: true,
          defaultOriginLocation: true,
        },
      },
      placements: {
        include: {
          container: {
            include: {
              location: true,
            },
          },
        },
      },
    });
    expect(lastInventoryItemFindManyInclude).not.toHaveProperty(
      "originLocation",
    );
    expect(lastInventoryItemFindManyInclude).not.toHaveProperty("location");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      container: {
        visualPreset: {
          frontImageUrl: "/inventory/container-visual-catalog/39l/front.webp",
          id: "39L",
        },
        visualPresetKey: "39L",
      },
      id: "item-1",
      originLocationId: "location-living-room",
      originLocationName: "Living room",
      locationId: "location-garage-rack",
      locationName: "Garage rack",
    });
  });
});
