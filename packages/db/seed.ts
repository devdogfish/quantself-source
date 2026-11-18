import { Prisma } from "./generated/prisma/client";
import { prisma } from "./index";
import {
  inventoryContainerSeeds,
  inventoryContainerVisualBoundsSeeds,
} from "./seed-data";

try {
  await seedInventoryContainerVisualBounds();
  await seedInventoryContainers();
} finally {
  await prisma.$disconnect();
}

async function seedInventoryContainerVisualBounds(): Promise<void> {
  for (const preset of inventoryContainerVisualBoundsSeeds) {
    await prisma.inventoryContainerVisualBoundsOverride.upsert({
      where: { presetKey: preset.presetKey },
      update: {},
      create: {
        presetKey: preset.presetKey,
        bounds: preset.bounds as unknown as Prisma.InputJsonValue,
        hoverBounds: preset.hoverBounds as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

async function seedInventoryContainers(): Promise<void> {
  for (const container of inventoryContainerSeeds) {
    const normalizedName = normalizeInventoryContainerName(container.name);

    await prisma.inventoryContainer.upsert({
      where: { referenceId: container.referenceId },
      update: {
        name: container.name,
        normalizedName,
        sizeLiters: container.sizeLiters,
        visualPresetKey: container.visualPresetKey,
      },
      create: {
        ...container,
        normalizedName,
        locationId: null,
        metadata: {
          seededBy: "packages/db/seed.ts",
        },
      },
    });
  }
}

function normalizeInventoryContainerName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}
