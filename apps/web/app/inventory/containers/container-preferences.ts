export type ContainerView = "scroll" | "bento";

export type ContainerPreferences = {
  scrollContainerId?: string;
  version: 1;
  view: ContainerView;
};

export const CONTAINER_PREFERENCES_STORAGE_KEY =
  "quantself:inventory:containers:preferences";

export function readContainerPreferences(
  storage: Pick<Storage, "getItem">,
): ContainerPreferences | null {
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(CONTAINER_PREFERENCES_STORAGE_KEY) ?? "null",
    );

    if (!isRecord(parsed) || parsed.version !== 1) return null;
    if (parsed.view !== "scroll" && parsed.view !== "bento") return null;
    if (
      parsed.scrollContainerId !== undefined &&
      (typeof parsed.scrollContainerId !== "string" ||
        parsed.scrollContainerId.length === 0)
    ) {
      return null;
    }

    return {
      ...(parsed.scrollContainerId
        ? { scrollContainerId: parsed.scrollContainerId }
        : {}),
      version: 1,
      view: parsed.view,
    };
  } catch {
    return null;
  }
}

export function writeContainerPreferences(
  storage: Pick<Storage, "setItem">,
  preferences: ContainerPreferences,
): void {
  try {
    storage.setItem(
      CONTAINER_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // Storage can be unavailable or full; preferences remain best-effort.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
