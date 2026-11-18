export type InventoryContainerReferenceSource = {
  referenceId: string;
};

export function normalizeInventoryContainerReferenceId(
  referenceId: string,
): string {
  return referenceId.trim().replace(/\s+/g, "-").toUpperCase();
}

export function generateInventoryContainerReferenceId(
  containers: InventoryContainerReferenceSource[],
): string {
  const used = new Set(
    containers.map((container) =>
      normalizeInventoryContainerReferenceId(container.referenceId),
    ),
  );
  const nextNumber =
    Math.max(
      0,
      ...[...used].map((referenceId) => {
        const match = /^BIN-(\d+)$/.exec(referenceId);

        return match ? Number(match[1]) : 0;
      }),
    ) + 1;

  for (let number = nextNumber; ; number++) {
    const referenceId = `BIN-${number.toString().padStart(4, "0")}`;

    if (!used.has(referenceId)) {
      return referenceId;
    }
  }
}
