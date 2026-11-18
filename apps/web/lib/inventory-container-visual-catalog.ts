export type InventoryContainerVisualKey = "6L" | "39L" | "80L";

export type InventoryContainerVisualPoint = {
  x: number;
  y: number;
};

export type InventoryContainerVisualBounds = readonly [
  InventoryContainerVisualPoint,
  InventoryContainerVisualPoint,
  InventoryContainerVisualPoint,
  InventoryContainerVisualPoint,
];

export type InventoryContainerVisualRole = "back" | "empty" | "front" | "shadow";

export type InventoryContainerVisualAsset = {
  pngPath: string;
  webpPath: string;
};

export type InventoryContainerVisualCatalogEntry = {
  assets: Record<InventoryContainerVisualRole, InventoryContainerVisualAsset>;
  dimensions: {
    height: number;
    width: number;
  };
  isDefault: boolean;
  itemBounds: InventoryContainerVisualBounds;
  key: InventoryContainerVisualKey;
  name: string;
};

export const DEFAULT_INVENTORY_CONTAINER_VISUAL_KEY: InventoryContainerVisualKey =
  "6L";

export const INVENTORY_CONTAINER_VISUAL_KEYS = [
  "6L",
  "39L",
  "80L",
] as const satisfies readonly InventoryContainerVisualKey[];

function buildAssets(
  directory: "6l" | "39l" | "80l",
): Record<InventoryContainerVisualRole, InventoryContainerVisualAsset> {
  return {
    back: {
      pngPath: `/inventory/container-visual-catalog/${directory}/back.png`,
      webpPath: `/inventory/container-visual-catalog/${directory}/back.webp`,
    },
    empty: {
      pngPath: `/inventory/container-visual-catalog/${directory}/empty.png`,
      webpPath: `/inventory/container-visual-catalog/${directory}/empty.webp`,
    },
    front: {
      pngPath: `/inventory/container-visual-catalog/${directory}/front.png`,
      webpPath: `/inventory/container-visual-catalog/${directory}/front.webp`,
    },
    shadow: {
      pngPath: `/inventory/container-visual-catalog/${directory}/shadow.png`,
      webpPath: `/inventory/container-visual-catalog/${directory}/shadow.webp`,
    },
  };
}

export const INVENTORY_CONTAINER_VISUAL_CATALOG = [
  {
    key: "6L",
    name: "6L",
    isDefault: true,
    dimensions: {
      width: 1660,
      height: 682,
    },
    assets: buildAssets("6l"),
    itemBounds: [
      { x: 0.129, y: 0.1572 },
      { x: 0.8722, y: 0.1572 },
      { x: 0.8536, y: 0.6641 },
      { x: 0.1476, y: 0.6641 },
    ],
  },
  {
    key: "39L",
    name: "39L",
    isDefault: false,
    dimensions: {
      width: 1456,
      height: 857,
    },
    assets: buildAssets("39l"),
    itemBounds: [
      { x: 0.1856, y: 0.1943 },
      { x: 0.8137, y: 0.1943 },
      { x: 0.7768, y: 0.6736 },
      { x: 0.2225, y: 0.6736 },
    ],
  },
  {
    key: "80L",
    name: "80L",
    isDefault: false,
    dimensions: {
      width: 1504,
      height: 852,
    },
    assets: buildAssets("80l"),
    itemBounds: [
      { x: 0.167, y: 0.1949 },
      { x: 0.8344, y: 0.1949 },
      { x: 0.7973, y: 0.694 },
      { x: 0.2041, y: 0.694 },
    ],
  },
] as const satisfies readonly InventoryContainerVisualCatalogEntry[];

export function listInventoryContainerVisualCatalog(): InventoryContainerVisualCatalogEntry[] {
  return [...INVENTORY_CONTAINER_VISUAL_CATALOG];
}

export function getInventoryContainerVisualCatalogEntry(
  key: string,
): InventoryContainerVisualCatalogEntry | null {
  return (
    INVENTORY_CONTAINER_VISUAL_CATALOG.find((entry) => entry.key === key) ??
    null
  );
}

export function getDefaultInventoryContainerVisualCatalogEntry(): InventoryContainerVisualCatalogEntry {
  return (
    INVENTORY_CONTAINER_VISUAL_CATALOG.find((entry) => entry.isDefault) ??
    INVENTORY_CONTAINER_VISUAL_CATALOG[0]
  );
}

export function isInventoryContainerVisualBounds(
  value: unknown,
): value is InventoryContainerVisualBounds {
  if (!Array.isArray(value) || value.length !== 4) {
    return false;
  }

  const bounds = value as InventoryContainerVisualPoint[];

  if (
    !bounds.every(
      (point) =>
        typeof point === "object" &&
        point !== null &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x >= 0 &&
        point.x <= 1 &&
        point.y >= 0 &&
        point.y <= 1,
    )
  ) {
    return false;
  }

  const crossProducts = bounds.map((point, index) => {
    const next = bounds[(index + 1) % bounds.length]!;
    const afterNext = bounds[(index + 2) % bounds.length]!;

    return (
      (next.x - point.x) * (afterNext.y - next.y) -
      (next.y - point.y) * (afterNext.x - next.x)
    );
  });

  return crossProducts.every((crossProduct) => crossProduct > Number.EPSILON);
}
