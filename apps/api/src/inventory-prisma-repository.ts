import { prisma } from "@quantself/db";
import { Prisma } from "@quantself/db/generated/prisma/client";
import type {
  InventoryEnrichmentJob,
  InventoryEnrichmentSettings,
  InventoryItemAudio,
  InventoryItemAsset,
  InventoryItemImage,
  InventoryPreprocessingJob,
  InventoryLocation,
} from "@quantself/db/generated/prisma/client";
import {
  getDefaultInventoryContainerVisualCatalogEntry,
  getInventoryContainerVisualCatalogEntry,
  listInventoryContainerVisualCatalog,
} from "../../web/lib/inventory-container-visual-catalog";
import type {
  InventoryEnrichmentFailureDetail,
  InventoryEnrichmentInputSnapshot,
  InventoryEnrichmentJobKind,
  InventoryEnrichmentNewJobRecord,
  InventoryEnrichmentJobRecord,
  InventoryEnrichmentJobStatus,
  InventoryEnrichmentRepository,
  InventoryEnrichmentResultPayload,
  InventoryEnrichmentSettingsRecord,
} from "./inventory-enrichment-service";
import type {
  InventoryPreprocessingJobRecord,
  InventoryPreprocessingFailureDetail,
  InventoryPreprocessingRuntimeRepository,
  InventoryPreprocessingNewJobRecord,
  InventoryPreprocessingStatus,
  InventoryPreprocessingSourceRef,
  InventoryTextBundle,
} from "./inventory-preprocessing-service";
import { inventorySearchTerms } from "../../web/lib/inventory-search";
import {
  buildInventoryItemSearchTextForContainer,
  buildInventoryItemSearchText,
  cleanOptional,
  INVENTORY_ITEM_MANUAL_FIELD_LOCKS_METADATA_KEY,
  defaultInventoryClothingProfileAttributes,
  type InventoryArchiveRepository,
  type InventoryContainerRepository,
  type InventoryContainerRecord,
  type InventoryContainerReferenceAllocator,
  type InventoryContainerReferenceRepository,
  type InventoryContainerVisualPresetRecord,
  type InventoryContainerVisualPresetRepository,
  type InventoryItemAssetRecord,
  type InventoryItemAudioRecord,
  type InventoryItemMutationRepository,
  type InventoryPlacementMutationRepository,
  type InventoryRelocationRepository,
  type InventoryItemUpdateRecordInput,
  normalizeInventoryLocationName,
  readInventoryItemManualFieldLocks,
  type InventoryImportance,
  type InventoryItemKind,
  type InventoryItemRecord,
  type InventoryItemStatus,
  type InventoryLocationKind,
  type InventoryLocationRecord,
  type InventoryRepository,
  type InventorySearchFilters,
  type InventorySessionRecord,
} from "./inventory-service";

const containerInclude = {
  location: true,
} satisfies Prisma.InventoryContainerInclude;

const captureSessionItemInclude = {
  defaultOriginLocation: true,
  defaultDestinationLocation: true,
} satisfies Prisma.InventoryCaptureSessionInclude;

const sessionInclude = {
  defaultOriginLocation: true,
  defaultDestinationLocation: true,
  defaultContainer: {
    include: containerInclude,
  },
} satisfies Prisma.InventoryCaptureSessionInclude;

const itemInclude = {
  captureSession: {
    include: captureSessionItemInclude,
  },
  clothingProfile: true,
  remedyProfile: {
    include: {
      substance: {
        select: {
          id: true,
        },
      },
    },
  },
  placements: {
    orderBy: {
      createdAt: "asc",
    },
    include: {
      container: {
        include: containerInclude,
      },
    },
  },
  images: {
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  },
  audioNotes: {
    orderBy: {
      createdAt: "asc",
    },
  },
  assets: {
    orderBy: {
      createdAt: "asc",
    },
  },
} satisfies Prisma.InventoryItemInclude;

const containerSummaryInclude = {
  location: true,
  placements: {
    where: {
      item: {
        archivedAt: null,
      },
    },
    orderBy: {
      item: {
        capturedAt: "desc",
      },
    },
    include: {
      item: {
        include: {
          images: {
            orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          },
          placements: {
            select: {
              quantity: true,
            },
          },
          audioNotes: {
            orderBy: {
              createdAt: "asc",
            },
            take: 1,
          },
          assets: {
            orderBy: {
              createdAt: "asc",
            },
            where: {
              mimeType: {
                startsWith: "video/",
              },
            },
            take: 1,
          },
        },
      },
    },
  },
  _count: {
    select: {
      placements: {
        where: {
          item: {
            archivedAt: null,
          },
        },
      },
    },
  },
} satisfies Prisma.InventoryContainerInclude;

type InventoryContainerWithRelations = Prisma.InventoryContainerGetPayload<{
  include: typeof containerInclude;
}>;

type InventoryContainerSummaryWithRelations =
  Prisma.InventoryContainerGetPayload<{
    include: typeof containerSummaryInclude;
  }>;

type InventorySessionWithRelations = Prisma.InventoryCaptureSessionGetPayload<{
  include: typeof sessionInclude;
}>;

type InventoryItemWithRelations = Prisma.InventoryItemGetPayload<{
  include: typeof itemInclude;
}>;

type InventoryBrowseRepository = {
  listAllInventoryItems(): Promise<InventoryItemRecord[]>;
  listAllInventoryPreprocessingJobs(): Promise<
    InventoryPreprocessingJobRecord[]
  >;
  listAllInventoryEnrichmentJobs(): Promise<InventoryEnrichmentJobRecord[]>;
};

export const inventoryRepository: InventoryRepository &
  InventoryArchiveRepository &
  InventoryContainerRepository &
  InventoryContainerReferenceAllocator &
  InventoryContainerReferenceRepository &
  InventoryContainerVisualPresetRepository &
  InventoryItemMutationRepository &
  InventoryPlacementMutationRepository &
  InventoryRelocationRepository &
  InventoryEnrichmentRepository &
  InventoryPreprocessingRuntimeRepository &
  InventoryBrowseRepository = {
  async upsertLocation(input) {
    const name = cleanOptional(input.name);
    const kind = input.kind ?? "OTHER";

    if (!name) {
      return null;
    }

    const normalizedName = normalizeInventoryLocationName(name);
    const location = await prisma.inventoryLocation.upsert({
      where: { normalizedName },
      update: { kind, name },
      create: { name, normalizedName, kind },
    });

    return mapLocation(location);
  },

  async upsertContainer(input) {
    const data = {
      name: input.name,
      normalizedName: input.normalizedName,
      referenceId: input.referenceId,
      locationId: input.location?.id ?? null,
      visualPresetKey: input.visualPresetKey,
      sizeLiters: input.sizeLiters ?? null,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    };
    const container = input.id
      ? await prisma.inventoryContainer.upsert({
          where: { id: input.id },
          create: {
            id: input.id,
            ...data,
          },
          update: data,
          include: containerInclude,
        })
      : await prisma.inventoryContainer.create({
          data,
          include: containerInclude,
        });

    return mapContainer(container);
  },

  async allocateContainerReferenceId() {
    for (;;) {
      const rows = await prisma.$queryRaw<Array<{ value: bigint }>>`
        SELECT nextval('inventory_container_reference_seq') AS value
      `;
      const value = rows[0]?.value;

      if (value === undefined) {
        throw new Error("Could not allocate a container reference ID.");
      }

      const referenceId = `BIN-${Number(value).toString().padStart(4, "0")}`;
      const existing = await prisma.inventoryContainer.findUnique({
        where: { referenceId },
        select: { id: true },
      });

      if (!existing) {
        return referenceId;
      }
    }
  },

  async listContainerVisualPresets() {
    return listInventoryContainerVisualCatalog().map((preset) =>
      mapContainerVisualPreset(preset.key),
    );
  },

  async getContainer(id) {
    const container = await prisma.inventoryContainer.findUnique({
      where: { id },
      include: containerInclude,
    });

    return container ? mapContainer(container) : null;
  },

  async getContainerByReferenceId(referenceId) {
    const container = await prisma.inventoryContainer.findUnique({
      where: { referenceId },
      include: containerInclude,
    });

    return container ? mapContainer(container) : null;
  },

  async listContainers() {
    const containers = await prisma.inventoryContainer.findMany({
      orderBy: { name: "asc" },
      include: containerInclude,
    });

    return containers.map(mapContainer);
  },

  async listContainerSummaries() {
    const containers = await prisma.inventoryContainer.findMany({
      orderBy: { name: "asc" },
      include: containerSummaryInclude,
    });

    return containers.map(mapContainerSummary);
  },

  async listItemsForContainer(id) {
    const items = await prisma.inventoryItem.findMany({
      where: {
        archivedAt: null,
        placements: {
          some: {
            containerId: id,
          },
        },
      },
      orderBy: { capturedAt: "desc" },
      include: itemInclude,
    });

    return items.map((item) => mapItem(item as InventoryItemWithRelations));
  },

  async deleteContainer(id) {
    await prisma.inventoryContainer.delete({
      where: { id },
    });
  },

  async upsertCaptureSession(input) {
    const data = {
      label: input.label,
      defaultOriginLocationId: input.defaultOriginLocation?.id ?? null,
      defaultDestinationLocationId:
        input.defaultDestinationLocation?.id ?? null,
      defaultContainerId: input.defaultContainer?.id ?? null,
      defaultContainerLabel: input.defaultContainerLabel ?? null,
      note: input.note ?? null,
    };
    const session = input.id
      ? await prisma.inventoryCaptureSession.upsert({
          where: { id: input.id },
          create: {
            id: input.id,
            ...data,
          },
          update: data,
          include: sessionInclude,
        })
      : await prisma.inventoryCaptureSession.create({
          data,
          include: sessionInclude,
        });

    return mapSession(session);
  },

  async getCaptureSession(id) {
    const session = await prisma.inventoryCaptureSession.findUnique({
      where: { id },
      include: sessionInclude,
    });

    return session ? mapSession(session) : null;
  },

  async getActiveCaptureSession() {
    const session = await prisma.inventoryCaptureSession.findFirst({
      where: { endedAt: null },
      orderBy: { startedAt: "desc" },
      include: sessionInclude,
    });

    return session ? mapSession(session) : null;
  },

  async createItem(input) {
    const item = (await prisma.inventoryItem.create({
      data: {
        captureSessionId: input.captureSessionId,
        kind: input.kind,
        title: input.title,
        note: input.note,
        captureText: input.captureText ?? null,
        status: input.status,
        importance: input.importance,
        category: input.category as Prisma.InventoryItemCreateInput["category"],
        clothingProfile: input.clothingProfile
          ? {
              create: {
                attributes:
                  input.clothingProfile.attributes as unknown as Prisma.InputJsonValue,
                dirtyQuantity: input.clothingProfile.dirtyQuantity ?? 0,
                isDirty: input.clothingProfile.isDirty,
              },
            }
          : undefined,
        remedyProfile: input.remedyProfile
          ? {
              create: {
                externalReferences:
                  input.remedyProfile.externalReferences as unknown as Prisma.InputJsonValue,
                potencies: input.remedyProfile.potencies,
                registeredByClientId: input.remedyProfile.registeredByClientId,
                selectionSummary: input.remedyProfile.selectionSummary,
                substanceId: input.remedyProfile.substanceId,
              },
            }
          : undefined,
        acquisitionSource:
          input.acquisitionSource as Prisma.InventoryItemCreateInput["acquisitionSource"],
        costCents: input.costCents ?? null,
        costCurrency: input.costCurrency,
        tags: input.tags,
        aliases: input.aliases,
        searchText: input.searchText,
        metadata: input.metadata as Prisma.InputJsonValue,
        archivedAt: input.archivedAt,
        placements: {
          create: input.initialPlacement ?? {
            containerId: input.containerId ?? null,
            note: input.containerId ? null : input.containerLabel,
            quantity: input.totalQuantity ?? 1,
          },
        },
        images: createImagesInput(input.images),
        audioNotes: createAudioNotesInput(input.audioNotes ?? []),
        assets: createAssetsInput(input.assets ?? []),
      },
      include: itemInclude,
    })) as InventoryItemWithRelations;

    return mapItem(item, {
      originLocationId: input.originLocationId ?? null,
      originLocationName: input.originLocationName ?? null,
      locationId: input.locationId ?? null,
      locationName: input.locationName ?? null,
    });
  },

  async getInventoryItem(id) {
    const item = await prisma.inventoryItem.findUnique({
      where: { id },
      include: itemInclude,
    });

    return item ? mapItem(item as InventoryItemWithRelations) : null;
  },

  async updateItem(input) {
    const item = (await prisma.inventoryItem.update({
      where: { id: input.id },
      data: {
        kind: input.kind,
        title: input.title,
        note: input.note,
        captureText: input.captureText,
        status: input.status,
        importance: input.importance,
        category:
          input.category as Prisma.InventoryItemUpdateInput["category"],
        acquisitionSource:
          input.acquisitionSource as Prisma.InventoryItemUpdateInput["acquisitionSource"],
        costCents: input.costCents,
        costCurrency: input.costCurrency,
        tags: input.tags,
        aliases: input.aliases,
        searchText: input.searchText,
        metadata: input.metadata as Prisma.InputJsonValue,
        clothingProfile: input.category === "clothing"
          ? {
              upsert: {
                create: {
                    attributes:
                      defaultInventoryClothingProfileAttributes() as unknown as Prisma.InputJsonValue,
                  isDirty: false,
                },
                update: {},
              },
            }
          : undefined,
        images: updateImagesInput(input),
        audioNotes: updateAudioNotesInput(input),
        assets: updateAssetsInput(input),
      },
      include: itemInclude,
    })) as InventoryItemWithRelations;

    return mapItem(item);
  },

  async setItemArchivedAt(id, archivedAt) {
    const item = (await prisma.inventoryItem.update({
      where: { id },
      data: { archivedAt },
      include: itemInclude,
    })) as InventoryItemWithRelations;

    return mapItem(item);
  },

  async moveItemsToContainer(input) {
    return prisma.$transaction(async (transaction) => {
      const container = await transaction.inventoryContainer.findUnique({
        where: { id: input.containerId },
        select: {
          id: true,
          name: true,
          referenceId: true,
          location: {
            select: { name: true },
          },
        },
      });

      if (!container) {
        throw new Error("Destination container was not found.");
      }

      const movable = await transaction.inventoryItem.findMany({
        where: {
          archivedAt: null,
          id: { in: input.itemIds },
        },
        include: itemInclude,
      });

      if (movable.length !== input.itemIds.length) {
        throw new Error(
          "One or more selected items were missing or archived. Nothing was moved.",
        );
      }

      for (const item of movable) {
        const quantity = item.placements.reduce(
          (total, placement) => total + placement.quantity,
          0,
        );

        await transaction.inventoryItemPlacement.deleteMany({
          where: {
            itemId: item.id,
          },
        });
        await transaction.inventoryItemPlacement.create({
          data: {
            containerId: input.containerId,
            itemId: item.id,
            quantity,
          },
        });
        await transaction.inventoryItem.update({
          where: { id: item.id },
          data: {
            searchText: buildInventoryItemSearchTextForContainer(
              mapItem(item as InventoryItemWithRelations),
              container,
            ),
          },
        });
      }

      const items = await transaction.inventoryItem.findMany({
        where: { id: { in: input.itemIds } },
        orderBy: { capturedAt: "desc" },
        include: itemInclude,
      });

      return items.map((item) =>
        mapItem(item as InventoryItemWithRelations),
      );
    });
  },

  async addInventoryUnits(input) {
    return prisma.$transaction(
      async (transaction) => {
        await requireActiveItem(transaction, input.itemId);
        await requirePlacementContainer(transaction, input.containerId);
        await requirePlacementLocation(transaction, input.locationId);

        const existing = await transaction.inventoryItemPlacement.findFirst({
          where: placementLookupWhere(input),
        });

        if (existing) {
          await transaction.inventoryItemPlacement.update({
            where: { id: existing.id },
            data: {
              note: input.note ?? existing.note,
              quantity: { increment: input.quantity },
            },
          });
        } else {
          await transaction.inventoryItemPlacement.create({
            data: {
              containerId: input.containerId,
              itemId: input.itemId,
              locationId: input.locationId,
              note: input.note,
              quantity: input.quantity,
            },
          });
        }

        return refreshInventoryItem(transaction, input.itemId);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  },

  async moveInventoryUnits(input) {
    return prisma.$transaction(
      async (transaction) => {
        await requireActiveItem(transaction, input.itemId);
        await requirePlacementContainer(
          transaction,
          input.sourceContainerId,
        );
        await requirePlacementLocation(
          transaction,
          input.sourceLocationId,
        );
        await requirePlacementContainer(
          transaction,
          input.destinationContainerId,
        );
        await requirePlacementLocation(
          transaction,
          input.destinationLocationId,
        );

        const source = await transaction.inventoryItemPlacement.findFirst({
          where: placementLookupWhere({
            containerId: input.sourceContainerId,
            itemId: input.itemId,
            locationId: input.sourceLocationId,
          }),
        });

        if (!source || source.quantity < input.quantity) {
          throw new Error("Move quantity exceeds available units.");
        }

        const destination =
          await transaction.inventoryItemPlacement.findFirst({
            where: placementLookupWhere({
              containerId: input.destinationContainerId,
              itemId: input.itemId,
              locationId: input.destinationLocationId,
            }),
          });

        if (source.quantity === input.quantity) {
          await transaction.inventoryItemPlacement.delete({
            where: { id: source.id },
          });
        } else {
          await transaction.inventoryItemPlacement.update({
            where: { id: source.id },
            data: { quantity: { decrement: input.quantity } },
          });
        }

        if (destination) {
          await transaction.inventoryItemPlacement.update({
            where: { id: destination.id },
            data: { quantity: { increment: input.quantity } },
          });
        } else {
          await transaction.inventoryItemPlacement.create({
            data: {
              containerId: input.destinationContainerId,
              itemId: input.itemId,
              locationId: input.destinationLocationId,
              quantity: input.quantity,
            },
          });
        }

        return refreshInventoryItem(transaction, input.itemId);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  },

  async removeInventoryUnits(input) {
    return prisma.$transaction(
      async (transaction) => {
        await requireActiveItem(transaction, input.itemId);
        await requirePlacementContainer(transaction, input.containerId);
        await requirePlacementLocation(transaction, input.locationId);
        const placement =
          await transaction.inventoryItemPlacement.findFirst({
            where: placementLookupWhere(input),
          });

        if (!placement || placement.quantity < input.quantity) {
          throw new Error("Remove quantity exceeds available units.");
        }

        if (placement.quantity === input.quantity) {
          await transaction.inventoryItemPlacement.delete({
            where: { id: placement.id },
          });
        } else {
          await transaction.inventoryItemPlacement.update({
            where: { id: placement.id },
            data: { quantity: { decrement: input.quantity } },
          });
        }

        return refreshInventoryItem(transaction, input.itemId);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  },

  async reorderInventoryItemImages(input) {
    return prisma.$transaction(async (transaction) => {
      await requireActiveItem(transaction, input.itemId);
      const images = await transaction.inventoryItemImage.findMany({
        where: { itemId: input.itemId },
        select: { id: true },
      });
      const currentIds = images.map(({ id }) => id).sort();
      const requestedIds = [...new Set(input.imageIds)].sort();

      if (
        currentIds.length !== requestedIds.length ||
        currentIds.some((id, index) => id !== requestedIds[index])
      ) {
        throw new Error("Image order must include every Item Image exactly once.");
      }

      await Promise.all(
        input.imageIds.map((id, position) =>
          transaction.inventoryItemImage.update({
            where: { id },
            data: { position },
          }),
        ),
      );

      return refreshInventoryItem(transaction, input.itemId);
    });
  },

  async deleteItem(id) {
    await prisma.inventoryItem.delete({
      where: { id },
    });
  },

  async listRecentItems(limit) {
    const items = await prisma.inventoryItem.findMany({
      where: { archivedAt: null },
      orderBy: { capturedAt: "desc" },
      take: limit,
      include: itemInclude,
    });

    return items.map((item) => mapItem(item as InventoryItemWithRelations));
  },

  async listAllInventoryItems() {
    const items = await prisma.inventoryItem.findMany({
      where: { archivedAt: null },
      orderBy: { capturedAt: "desc" },
      include: itemInclude,
    });

    return items.map((item) => mapItem(item as InventoryItemWithRelations));
  },

  async listArchivedItems() {
    const items = await prisma.inventoryItem.findMany({
      where: { archivedAt: { not: null } },
      orderBy: { archivedAt: "desc" },
      include: itemInclude,
    });

    return items.map((item) => mapItem(item as InventoryItemWithRelations));
  },

  async findInventoryItems(filters) {
    const where = buildInventoryWhere(filters);
    const items = await prisma.inventoryItem.findMany({
      where,
      orderBy: { capturedAt: "desc" },
      take: 200,
      include: itemInclude,
    });

    return items.map((item) => mapItem(item as InventoryItemWithRelations));
  },

  async enqueueInventoryEnrichmentJobs(jobs) {
    if (jobs.length === 0) {
      return [];
    }

    const createdJobs = await prisma.$transaction(
      jobs.map((job) =>
        prisma.inventoryEnrichmentJob.create({
          data: toEnrichmentJobCreateData(job),
        }),
      ),
    );

    return createdJobs.map(mapEnrichmentJob);
  },

  async enqueueInventoryPreprocessingJobs(jobs) {
    if (jobs.length === 0) {
      return [];
    }

    const createdJobs = await prisma.$transaction(
      jobs.map((job) =>
        prisma.inventoryPreprocessingJob.create({
          data: toPreprocessingJobCreateData(job),
        }),
      ),
    );

    return createdJobs.map(mapPreprocessingJob);
  },

  async listClaimableInventoryPreprocessingJobs(input) {
    const jobs = await prisma.inventoryPreprocessingJob.findMany({
      where: {
        OR: [
          { status: "QUEUED" },
          {
            leaseExpiresAt: { lte: input.now },
            status: "PROCESSING",
          },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: input.limit,
    });

    return jobs.map(mapPreprocessingJob);
  },

  async listInventoryPreprocessingJobs(input) {
    const jobs = await prisma.inventoryPreprocessingJob.findMany({
      orderBy: { updatedAt: "desc" },
      take: input?.limit ?? 50,
      where:
        input?.status || input?.targetItemId
          ? {
              status: input.status,
              targetItemId: input.targetItemId,
            }
          : undefined,
    });

    return jobs.map(mapPreprocessingJob);
  },

  async listAllInventoryPreprocessingJobs() {
    const jobs = await prisma.inventoryPreprocessingJob.findMany({
      orderBy: { updatedAt: "desc" },
    });

    return jobs.map(mapPreprocessingJob);
  },

  async updateInventoryPreprocessingJob(job) {
    const updatedJob = await prisma.inventoryPreprocessingJob.update({
      where: { id: job.id },
      data: toPreprocessingJobUpdateData(job),
    });

    return mapPreprocessingJob(updatedJob);
  },

  async completeInventoryPreprocessingJob(input) {
    return prisma.$transaction(
      async (transaction) => {
        if (input.enrichmentJob) {
          const existingHandoff =
            await transaction.inventoryEnrichmentJob.findFirst({
              where: {
                inputFingerprint: input.enrichmentJob.inputFingerprint,
                kind: input.enrichmentJob.kind,
                targetItemId: input.enrichmentJob.targetItemId,
              },
            });

          if (!existingHandoff) {
            await transaction.inventoryEnrichmentJob.create({
              data: toEnrichmentJobCreateData(input.enrichmentJob),
            });
          }
        }

        const updatedJob = await transaction.inventoryPreprocessingJob.update({
          where: { id: input.job.id },
          data: toPreprocessingJobUpdateData(input.job),
        });

        return mapPreprocessingJob(updatedJob);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  },

  async getInventoryPreprocessingJob(id) {
    const job = await prisma.inventoryPreprocessingJob.findUnique({
      where: { id },
    });

    return job ? mapPreprocessingJob(job) : null;
  },

  async listClaimableInventoryEnrichmentJobs(input) {
    const jobs = await prisma.inventoryEnrichmentJob.findMany({
      where: {
        OR: [
          { status: "QUEUED" },
          {
            leaseExpiresAt: { lte: input.now },
            status: "CLAIMED",
          },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: input.limit,
    });

    return jobs.map(mapEnrichmentJob);
  },

  async listInventoryEnrichmentJobs(input) {
    const jobs = await prisma.inventoryEnrichmentJob.findMany({
      orderBy: { updatedAt: "desc" },
      take: input?.limit ?? 50,
      where:
        input?.status || input?.targetItemId
          ? {
              status: input.status,
              targetItemId: input.targetItemId,
            }
          : undefined,
    });

    return jobs.map(mapEnrichmentJob);
  },

  async listAllInventoryEnrichmentJobs() {
    const jobs = await prisma.inventoryEnrichmentJob.findMany({
      orderBy: { updatedAt: "desc" },
    });

    return jobs.map(mapEnrichmentJob);
  },

  async updateInventoryEnrichmentJob(job) {
    const updatedJob = await prisma.inventoryEnrichmentJob.update({
      where: { id: job.id },
      data: toEnrichmentJobUpdateData(job),
    });

    return mapEnrichmentJob(updatedJob);
  },

  async getInventoryEnrichmentJob(id) {
    const job = await prisma.inventoryEnrichmentJob.findUnique({
      where: { id },
    });

    return job ? mapEnrichmentJob(job) : null;
  },

  async getInventoryEnrichmentSettings() {
    const settings = await prisma.inventoryEnrichmentSettings.upsert({
      where: { id: "default" },
      create: { id: "default" },
      update: {},
    });

    return mapEnrichmentSettings(settings);
  },

  async updateInventoryEnrichmentSettings(settings) {
    const updatedSettings = await prisma.inventoryEnrichmentSettings.upsert({
      where: { id: "default" },
      create: {
        approvalsRequired: settings.approvalsRequired,
        id: "default",
        updatedAt: settings.updatedAt,
      },
      update: {
        approvalsRequired: settings.approvalsRequired,
        updatedAt: settings.updatedAt,
      },
    });

    return mapEnrichmentSettings(updatedSettings);
  },

  async applyInventoryItemEnrichment(input) {
    const existingItem = await prisma.inventoryItem.findUnique({
      where: { id: input.itemId },
      select: {
        acquisitionSource: true,
        aliases: true,
        category: true,
        clothingProfile: {
          select: { itemId: true },
        },
        remedyProfile: {
          select: { itemId: true },
        },
        costCents: true,
        importance: true,
        metadata: true,
        note: true,
        searchText: true,
        status: true,
        tags: true,
        title: true,
      },
    });

    if (!existingItem) {
      throw new Error("Inventory item not found.");
    }

    const existingMetadata = toMetadataRecord(existingItem.metadata);
    const manualFieldLocks =
      readInventoryItemManualFieldLocks(existingMetadata);
    const isLocked = (field: (typeof manualFieldLocks)[number]) =>
      manualFieldLocks.includes(field);
    const category = isLocked("category")
      ? existingItem.category
      : input.category;

    if (category !== "clothing" && existingItem.clothingProfile) {
      throw new Error(
        "Inventory Clothing Profile conflicts with non-clothing category.",
      );
    }
    if (category !== "homeopathy" && existingItem.remedyProfile) {
      throw new Error(
        "Inventory Remedy Profile conflicts with non-homeopathy category.",
      );
    }

    const item = (await prisma.inventoryItem.update({
      where: { id: input.itemId },
      data: {
        acquisitionSource:
          (isLocked("acquisitionSource")
            ? existingItem.acquisitionSource
            : input.acquisitionSource) as Prisma.InventoryItemUpdateInput["acquisitionSource"],
        aliases: isLocked("aliases") ? existingItem.aliases : input.aliases,
        category: category as Prisma.InventoryItemUpdateInput["category"],
        clothingProfile: category === "clothing"
          ? {
              upsert: {
                create: {
                  attributes:
                    defaultInventoryClothingProfileAttributes() as unknown as Prisma.InputJsonValue,
                  isDirty: false,
                },
                update: {},
              },
            }
          : undefined,
        costCents: isLocked("costCents")
          ? existingItem.costCents
          : input.costCents,
        importance: isLocked("importance")
          ? existingItem.importance
          : input.importance,
        metadata: {
          ...existingMetadata,
          ...input.metadata,
          [INVENTORY_ITEM_MANUAL_FIELD_LOCKS_METADATA_KEY]:
            manualFieldLocks,
        } as Prisma.InputJsonValue,
        note: isLocked("note") ? existingItem.note : input.note,
        searchText: input.searchText,
        status: isLocked("status") ? existingItem.status : input.status,
        tags: isLocked("tags") ? existingItem.tags : input.tags,
        title: isLocked("title") ? existingItem.title : input.title,
      },
      include: itemInclude,
    })) as InventoryItemWithRelations;

    return mapItem(item);
  },

  async applyInventoryImageEnrichment(input) {
    const existingImage = await prisma.inventoryItemImage.findUnique({
      where: { id: input.imageId },
      select: { metadata: true },
    });

    if (!existingImage) {
      throw new Error("Inventory item image not found.");
    }

    const data: Prisma.InventoryItemImageUpdateInput = {
      caption: input.caption ?? undefined,
      ocrText: input.ocrText ?? undefined,
    };

    if (input.metadata !== null) {
      data.metadata = mergeImageEnrichmentMetadata(
        existingImage.metadata,
        input.metadata,
      );
    }

    await prisma.inventoryItemImage.update({
      where: { id: input.imageId },
      data,
    });
  },
};

async function requireActiveItem(
  transaction: Prisma.TransactionClient,
  itemId: string,
): Promise<InventoryItemWithRelations> {
  const item = await transaction.inventoryItem.findFirst({
    where: {
      archivedAt: null,
      id: itemId,
    },
    include: itemInclude,
  });

  if (!item) {
    throw new Error("Inventory Item was not found.");
  }

  return item as InventoryItemWithRelations;
}

async function requirePlacementContainer(
  transaction: Prisma.TransactionClient,
  containerId: string | null,
): Promise<void> {
  if (!containerId) {
    return;
  }

  const container = await transaction.inventoryContainer.findUnique({
    where: { id: containerId },
    select: { id: true },
  });

  if (!container) {
    throw new Error("Container was not found.");
  }
}

async function requirePlacementLocation(
  transaction: Prisma.TransactionClient,
  locationId: string | null,
): Promise<void> {
  if (!locationId) {
    return;
  }

  const location = await transaction.inventoryLocation.findUnique({
    where: { id: locationId },
    select: { id: true },
  });

  if (!location) {
    throw new Error("Inventory Location was not found.");
  }
}

function placementLookupWhere(input: {
  containerId: string | null;
  itemId: string;
  locationId: string | null;
}) {
  return {
    containerId: input.containerId,
    itemId: input.itemId,
    locationId: input.locationId,
  };
}

async function refreshInventoryItem(
  transaction: Prisma.TransactionClient,
  itemId: string,
): Promise<InventoryItemRecord> {
  const item = await transaction.inventoryItem.findUnique({
    where: { id: itemId },
    include: itemInclude,
  });

  if (!item) {
    throw new Error("Inventory Item was not found.");
  }

  const mapped = mapItem(item as InventoryItemWithRelations);
  const searchText = buildInventoryItemSearchText(mapped);

  if (searchText !== mapped.searchText) {
    await transaction.inventoryItem.update({
      where: { id: itemId },
      data: { searchText },
    });
    mapped.searchText = searchText;
  }

  return mapped;
}

export async function getInventoryImageFile(imageId: string): Promise<{
  filePath: string;
  mimeType: string | null;
  originalName: string | null;
} | null> {
  const image = await prisma.inventoryItemImage.findUnique({
    where: { id: imageId },
    select: {
      filePath: true,
      mimeType: true,
      originalName: true,
    },
  });

  return image;
}

export async function getInventoryAudioFile(audioId: string): Promise<{
  filePath: string;
  mimeType: string | null;
  originalName: string | null;
} | null> {
  return prisma.inventoryItemAudio.findUnique({
    where: { id: audioId },
    select: {
      filePath: true,
      mimeType: true,
      originalName: true,
    },
  });
}

export async function getInventoryAssetFile(assetId: string): Promise<{
  filePath: string;
  mimeType: string | null;
  originalName: string | null;
} | null> {
  return prisma.inventoryItemAsset.findUnique({
    where: { id: assetId },
    select: {
      filePath: true,
      mimeType: true,
      originalName: true,
    },
  });
}

function buildInventoryWhere(
  filters: InventorySearchFilters,
): Prisma.InventoryItemWhereInput {
  const where: Prisma.InventoryItemWhereInput = { archivedAt: null };
  const and: Prisma.InventoryItemWhereInput[] = [];
  const query = cleanOptional(filters.query);
  const container = cleanOptional(filters.container);
  const location = cleanOptional(filters.location);

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.importance) {
    where.importance = filters.importance;
  }

  if (filters.category) {
    where.category = filters.category;
  }

  if (filters.acquisitionSource) {
    where.acquisitionSource = filters.acquisitionSource;
  }

  if (container) {
    and.push({
      placements: {
        some: {
          OR: [
            { note: { contains: container, mode: "insensitive" } },
            {
              container: {
                is: {
                  OR: [
                    { name: { contains: container, mode: "insensitive" } },
                    {
                      referenceId: {
                        contains: container,
                        mode: "insensitive",
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    });
  }

  if (location) {
    and.push({
      placements: {
        some: {
          container: {
            is: {
              location: {
                is: {
                  name: { contains: location, mode: "insensitive" },
                },
              },
            },
          },
        },
      },
    });
  }

  if (query) {
    const queryWhere = buildInventoryQueryWhere(query);

    if (queryWhere) {
      and.push(queryWhere);
    }
  }

  if (and.length > 0) {
    where.AND = and;
  }

  return where;
}

function buildInventoryQueryWhere(
  query: string,
): Prisma.InventoryItemWhereInput | null {
  const terms = inventorySearchTerms(query);

  if (terms.length === 0) {
    return null;
  }

  return {
    AND: terms.map((term) => ({
      OR: [
        { searchText: { contains: term, mode: "insensitive" } },
        {
          placements: {
            some: {
              OR: [
                {
                  note: {
                    contains: term,
                    mode: "insensitive",
                  },
                },
                {
                  container: {
                    is: {
                      OR: [
                        {
                          name: {
                            contains: term,
                            mode: "insensitive",
                          },
                        },
                        {
                          referenceId: {
                            contains: term,
                            mode: "insensitive",
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    })),
  };
}

function mapLocation(location: InventoryLocation): InventoryLocationRecord {
  return {
    id: location.id,
    name: location.name,
    kind: location.kind as InventoryLocationKind,
  };
}

function mapOptionalLocation(
  location: InventoryLocation | null,
): InventoryLocationRecord | null {
  return location ? mapLocation(location) : null;
}

function mapContainer(
  container: InventoryContainerWithRelations,
): InventoryContainerRecord {
  return {
    id: container.id,
    referenceId: container.referenceId,
    name: container.name,
    normalizedName: container.normalizedName,
    locationId: container.locationId,
    location: mapOptionalLocation(container.location),
    visualPresetKey: container.visualPresetKey,
    visualPreset: mapContainerVisualPreset(container.visualPresetKey),
    sizeLiters: container.sizeLiters,
    metadata: toMetadataRecord(container.metadata),
    createdAt: container.createdAt,
    updatedAt: container.updatedAt,
  };
}

function mapOptionalContainer(
  container: InventoryContainerWithRelations | null,
): InventoryContainerRecord | null {
  return container ? mapContainer(container) : null;
}

function mapContainerSummary(
  container: InventoryContainerSummaryWithRelations,
) {
  const latestCapturedAt = container.placements[0]?.item.capturedAt ?? null;
  const prioritizedPlacements = [...container.placements].sort(
    (left, right) =>
      Number(right.item.images.length > 0) -
      Number(left.item.images.length > 0),
  );
  const sampleImages = prioritizedPlacements.flatMap(({ item }) =>
    item.images.map((image) => ({
      id: image.id,
      alt:
        image.caption ??
        item.title ??
        item.captureText ??
        "Inventory Item image",
      caption: image.caption,
    })),
  );

  return {
    id: container.id,
    referenceId: container.referenceId,
    name: container.name,
    locationName: container.location?.name ?? null,
    visualPresetKey: container.visualPresetKey,
    visualPreset: mapContainerVisualPreset(container.visualPresetKey),
    sizeLiters: container.sizeLiters,
    itemCount: container._count.placements,
    unitCount: container.placements.reduce(
      (total, placement) => total + placement.quantity,
      0,
    ),
    sampleImages,
    sampleItems: prioritizedPlacements.map(({ item, quantity }) => ({
      audioId: item.audioNotes[0]?.id ?? null,
      hasAudio: item.audioNotes.length > 0,
      id: item.id,
      localQuantity: quantity,
      imageHeight: item.images[0]?.height ?? null,
      imageId: item.images[0]?.id ?? null,
      imageIds: item.images.map((image) => image.id),
      imageWidth: item.images[0]?.width ?? null,
      textPreview: item.captureText,
      totalQuantity: item.placements.reduce(
        (total, placement) => total + placement.quantity,
        0,
      ),
      title:
        item.title ??
        item.captureText ??
        "Untitled Inventory Item",
      videoId: item.assets[0]?.id ?? null,
    })),
    latestCapturedAt,
  };
}

function mapContainerVisualPreset(
  key: string,
): InventoryContainerVisualPresetRecord {
  const preset =
    getInventoryContainerVisualCatalogEntry(key) ??
    getDefaultInventoryContainerVisualCatalogEntry();

  return {
    backImageUrl: preset.assets.back.webpPath,
    emptyImageUrl: preset.assets.empty.webpPath,
    frontImageUrl: preset.assets.front.webpPath,
    height: preset.dimensions.height,
    id: preset.key,
    name: preset.name,
    bounds: preset.itemBounds,
    isDefault: preset.isDefault,
    shadowImageUrl: preset.assets.shadow.webpPath,
    width: preset.dimensions.width,
  };
}

function mapSession(
  session: InventorySessionWithRelations,
): InventorySessionRecord {
  return {
    id: session.id,
    label: session.label,
    defaultOriginLocation: mapOptionalLocation(session.defaultOriginLocation),
    defaultDestinationLocation: mapOptionalLocation(
      session.defaultDestinationLocation,
    ),
    defaultContainer: mapOptionalContainer(session.defaultContainer),
    defaultContainerLabel: session.defaultContainerLabel,
    note: session.note,
    startedAt: session.startedAt,
  };
}

function mapItem(
  item: InventoryItemWithRelations,
  fallback?: {
    originLocationId: string | null;
    originLocationName: string | null;
    locationId: string | null;
    locationName: string | null;
  },
): InventoryItemRecord {
  const originLocation = item.captureSession?.defaultOriginLocation ?? null;
  const primaryPlacement = item.placements[0] ?? null;
  const currentLocation =
    primaryPlacement?.container?.location ??
    item.captureSession?.defaultDestinationLocation ??
    null;

  return mapItemWithFallback(item, {
    originLocationId: fallback?.originLocationId ?? originLocation?.id ?? null,
    originLocationName:
      fallback?.originLocationName ?? originLocation?.name ?? null,
    locationId: fallback?.locationId ?? currentLocation?.id ?? null,
    locationName: fallback?.locationName ?? currentLocation?.name ?? null,
  });
}

function mapItemWithFallback(
  item: InventoryItemWithRelations,
  fallback: {
    originLocationId: string | null;
    originLocationName: string | null;
    locationId: string | null;
    locationName: string | null;
  },
): InventoryItemRecord {
  const placements = item.placements.map(mapPlacement);
  const primaryPlacement = placements[0] ?? null;

  return {
    id: item.id,
    captureSessionId: item.captureSessionId,
    kind: item.kind as InventoryItemKind,
    title: item.title,
    note: item.note,
    captureText: item.captureText,
    status: item.status as InventoryItemStatus,
    importance: item.importance as InventoryImportance,
    originLocationId: fallback.originLocationId,
    originLocationName: fallback.originLocationName,
    locationId: fallback.locationId,
    locationName: fallback.locationName,
    containerId: primaryPlacement?.containerId ?? null,
    container: primaryPlacement?.container ?? null,
    containerLabel:
      primaryPlacement?.container?.name ?? primaryPlacement?.note ?? null,
    category: item.category,
    acquisitionSource: item.acquisitionSource,
    costCents: item.costCents,
    costCurrency: item.costCurrency,
    tags: item.tags,
    aliases: item.aliases,
    searchText: item.searchText,
    metadata: toMetadataRecord(item.metadata),
    clothingProfile: item.clothingProfile
      ? {
          attributes:
            item.clothingProfile.attributes as unknown as NonNullable<
              InventoryItemRecord["clothingProfile"]
            >["attributes"],
          createdAt: item.clothingProfile.createdAt,
          dirtyQuantity: item.clothingProfile.dirtyQuantity,
          isDirty: item.clothingProfile.isDirty,
          updatedAt: item.clothingProfile.updatedAt,
        }
      : null,
    remedyProfile: item.remedyProfile
      ? {
          createdAt: item.remedyProfile.createdAt,
          externalReferences:
            item.remedyProfile.externalReferences as unknown as NonNullable<
              InventoryItemRecord["remedyProfile"]
            >["externalReferences"],
          potencies: item.remedyProfile.potencies,
          registeredByClientId: item.remedyProfile.registeredByClientId,
          selectionSummary: item.remedyProfile.selectionSummary,
          substanceId: item.remedyProfile.substance.id,
          updatedAt: item.remedyProfile.updatedAt,
        }
      : null,
    archivedAt: item.archivedAt,
    placements,
    totalQuantity: placements.reduce(
      (total, placement) => total + placement.quantity,
      0,
    ),
    images: item.images.map(mapImage),
    audioNotes: item.audioNotes.map(mapAudioNote),
    assets: (item.assets ?? []).map(mapAsset),
    capturedAt: item.capturedAt,
  };
}

function createImagesInput(
  images: InventoryItemRecord["images"],
): Prisma.InventoryItemImageCreateNestedManyWithoutItemInput | undefined {
  if (images.length === 0) {
    return undefined;
  }

  return {
    create: images.map((image, index) => ({
      filePath: image.filePath,
      originalName: image.originalName ?? null,
      mimeType: image.mimeType ?? null,
      sizeBytes: image.sizeBytes ?? null,
      width: image.width ?? null,
      height: image.height ?? null,
      position: image.position ?? index,
      caption: image.caption ?? null,
      ocrText: image.ocrText ?? null,
      metadata: {},
    })),
  };
}

function createAudioNotesInput(
  audioNotes: InventoryItemAudioRecord[],
): Prisma.InventoryItemAudioCreateNestedManyWithoutItemInput | undefined {
  if (audioNotes.length === 0) {
    return undefined;
  }

  return {
    create: audioNotes.map((audioNote) => ({
      filePath: audioNote.filePath,
      originalName: audioNote.originalName ?? null,
      mimeType: audioNote.mimeType ?? null,
      sizeBytes: audioNote.sizeBytes ?? null,
      metadata: {},
    })),
  };
}

function createAssetsInput(
  assets: InventoryItemAssetRecord[],
): Prisma.InventoryItemAssetCreateNestedManyWithoutItemInput | undefined {
  if (assets.length === 0) {
    return undefined;
  }

  return {
    create: assets.map(toAssetCreateData),
  };
}

function updateImagesInput(
  input: InventoryItemUpdateRecordInput,
): Prisma.InventoryItemImageUpdateManyWithoutItemNestedInput | undefined {
  if (input.addImages.length === 0 && input.removeImageIds.length === 0) {
    return undefined;
  }

  return {
    create: input.addImages.map((image, index) => ({
      filePath: image.filePath,
      originalName: image.originalName ?? null,
      mimeType: image.mimeType ?? null,
      sizeBytes: image.sizeBytes ?? null,
      width: image.width ?? null,
      height: image.height ?? null,
      position: image.position ?? index,
      caption: image.caption ?? null,
      ocrText: image.ocrText ?? null,
      metadata: {},
    })),
    deleteMany:
      input.removeImageIds.length > 0
        ? { id: { in: input.removeImageIds } }
        : undefined,
  };
}

function updateAudioNotesInput(
  input: InventoryItemUpdateRecordInput,
): Prisma.InventoryItemAudioUpdateManyWithoutItemNestedInput | undefined {
  if (
    input.addAudioNotes.length === 0 &&
    input.removeAudioNoteIds.length === 0
  ) {
    return undefined;
  }

  return {
    create: input.addAudioNotes.map((audioNote) => ({
      filePath: audioNote.filePath,
      originalName: audioNote.originalName ?? null,
      mimeType: audioNote.mimeType ?? null,
      sizeBytes: audioNote.sizeBytes ?? null,
      metadata: {},
    })),
    deleteMany:
      input.removeAudioNoteIds.length > 0
        ? { id: { in: input.removeAudioNoteIds } }
        : undefined,
  };
}

function updateAssetsInput(
  input: InventoryItemUpdateRecordInput,
): Prisma.InventoryItemAssetUpdateManyWithoutItemNestedInput | undefined {
  if (input.addAssets.length === 0 && input.removeAssetIds.length === 0) {
    return undefined;
  }

  return {
    create: input.addAssets.map(toAssetCreateData),
    deleteMany:
      input.removeAssetIds.length > 0
        ? { id: { in: input.removeAssetIds } }
        : undefined,
  };
}

function toAssetCreateData(asset: InventoryItemAssetRecord) {
  return {
    filePath: asset.filePath,
    originalName: asset.originalName ?? null,
    mimeType: asset.mimeType ?? null,
    sizeBytes: asset.sizeBytes ?? null,
    metadata: {},
  };
}

function mapImage(
  image: InventoryItemImage,
): InventoryItemRecord["images"][number] {
  return {
    id: image.id,
    filePath: image.filePath,
    originalName: image.originalName,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    width: image.width,
    height: image.height,
    position: image.position,
    caption: image.caption,
    ocrText: image.ocrText,
  };
}

function mapPlacement(
  placement: InventoryItemWithRelations["placements"][number],
) {
  return {
    id: placement.id,
    itemId: placement.itemId,
    containerId: placement.containerId,
    container: mapOptionalContainer(placement.container),
    quantity: placement.quantity,
    note: placement.note,
    createdAt: placement.createdAt,
    updatedAt: placement.updatedAt,
  };
}

function mapAudioNote(audioNote: InventoryItemAudio): InventoryItemAudioRecord {
  return {
    id: audioNote.id,
    filePath: audioNote.filePath,
    originalName: audioNote.originalName,
    mimeType: audioNote.mimeType,
    sizeBytes: audioNote.sizeBytes,
  };
}

function mapAsset(asset: InventoryItemAsset): InventoryItemAssetRecord {
  return {
    id: asset.id,
    filePath: asset.filePath,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
  };
}

function toPreprocessingJobCreateData(job: InventoryPreprocessingNewJobRecord) {
  return {
    claimedAt: job.claimedAt,
    claimedBy: job.claimedBy,
    completedAt: null,
    leaseExpiresAt: job.leaseExpiresAt,
    maxAttempts: job.maxAttempts,
    sourceRefs: job.sourceRefs as unknown as Prisma.InputJsonValue,
    targetItemId: job.targetItemId,
  };
}

function toPreprocessingJobUpdateData(job: InventoryPreprocessingJobRecord) {
  return {
    ...toPreprocessingJobCreateData(job),
    attempts: job.attempts,
    completedAt: job.completedAt,
    failureDetail:
      job.failureDetail === null
        ? Prisma.DbNull
        : (job.failureDetail as Prisma.InputJsonValue),
    status: job.status,
    textBundle:
      job.textBundle === null
        ? Prisma.DbNull
        : (job.textBundle as Prisma.InputJsonValue),
    updatedAt: job.updatedAt,
  };
}

function toEnrichmentJobCreateData(job: InventoryEnrichmentNewJobRecord) {
  return {
    claimedAt: job.claimedAt,
    claimedBy: job.claimedBy,
    decidedAt: job.decidedAt,
    failureDetail:
      job.failureDetail === null
        ? Prisma.DbNull
        : (job.failureDetail as Prisma.InputJsonValue),
    inputFingerprint: job.inputFingerprint,
    inputSnapshot: job.inputSnapshot as unknown as Prisma.InputJsonValue,
    kind: job.kind,
    leaseExpiresAt: job.leaseExpiresAt,
    maxAttempts: job.maxAttempts,
    resultId: job.resultId,
    resultPayload:
      job.resultPayload === null
        ? Prisma.DbNull
        : (job.resultPayload as Prisma.InputJsonValue),
    targetImageId: job.targetImageId,
    targetItemId: job.targetItemId,
  };
}

function toEnrichmentJobUpdateData(job: InventoryEnrichmentJobRecord) {
  return {
    ...toEnrichmentJobCreateData(job),
    attempts: job.attempts,
    status: job.status,
    updatedAt: job.updatedAt,
  };
}

function mergeImageEnrichmentMetadata(
  metadata: unknown,
  enrichmentMetadata: Record<string, unknown>,
): Prisma.InputJsonValue {
  return {
    ...toMetadataRecord(metadata),
    enrichment: enrichmentMetadata,
  } as Prisma.InputJsonValue;
}

function mapEnrichmentSettings(
  settings: InventoryEnrichmentSettings,
): InventoryEnrichmentSettingsRecord {
  return {
    approvalsRequired: settings.approvalsRequired,
    updatedAt: settings.updatedAt,
  };
}

function mapEnrichmentJob(
  job: InventoryEnrichmentJob,
): InventoryEnrichmentJobRecord {
  return {
    attempts: job.attempts,
    claimedAt: job.claimedAt,
    claimedBy: job.claimedBy,
    createdAt: job.createdAt,
    decidedAt: job.decidedAt,
    failureDetail: job.failureDetail as InventoryEnrichmentFailureDetail | null,
    id: job.id,
    inputFingerprint: job.inputFingerprint,
    inputSnapshot:
      job.inputSnapshot as unknown as InventoryEnrichmentInputSnapshot,
    kind: job.kind as InventoryEnrichmentJobKind,
    leaseExpiresAt: job.leaseExpiresAt,
    maxAttempts: job.maxAttempts,
    resultId: job.resultId,
    resultPayload: job.resultPayload as InventoryEnrichmentResultPayload | null,
    status: job.status as InventoryEnrichmentJobStatus,
    targetImageId: job.targetImageId,
    targetItemId: job.targetItemId,
    updatedAt: job.updatedAt,
  };
}

function mapPreprocessingJob(
  job: InventoryPreprocessingJob,
): InventoryPreprocessingJobRecord {
  return {
    attempts: job.attempts,
    claimedAt: job.claimedAt,
    claimedBy: job.claimedBy,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    failureDetail:
      job.failureDetail as InventoryPreprocessingFailureDetail | null,
    id: job.id,
    leaseExpiresAt: job.leaseExpiresAt,
    maxAttempts: job.maxAttempts,
    sourceRefs: job.sourceRefs as InventoryPreprocessingSourceRef[],
    status: job.status as InventoryPreprocessingStatus,
    targetItemId: job.targetItemId,
    textBundle: job.textBundle as InventoryTextBundle | null,
    updatedAt: job.updatedAt,
  };
}

function toMetadataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}
