import type { InventoryContainerFormOption } from "./action-state";

export function mapContainerOption(
  container: {
    id: string;
    locationName?: string | null;
    location?: { name: string } | null;
    name: string;
    referenceId: string;
    sizeLiters: number | null;
    visualPresetKey?: string;
  },
): InventoryContainerFormOption {
  return {
    id: container.id,
    locationName: container.locationName ?? container.location?.name ?? null,
    name: container.name,
    referenceId: container.referenceId,
    sizeLiters: container.sizeLiters,
    visualPresetKey: container.visualPresetKey,
  };
}
