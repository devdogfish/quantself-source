import type { Metadata } from "next";
import { Suspense } from "react";
import {
  listInventoryContainers,
  listInventoryContainerVisuals,
} from "@/lib/quantself-api-client";
import { createInventoryContainerAction } from "../actions";
import { ContainersClient } from "./containers-client";
import type { ContainerView } from "./container-preferences";
import type { ContainerShelf } from "./types";
import InventoryContainersLoading from "./loading";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Container shelf · Quantself",
  description: "An immersive view of inventory containers.",
};

export default function InventoryContainersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<InventoryContainersLoading />}>
      <InventoryContainersContent searchParams={searchParams} />
    </Suspense>
  );
}

async function InventoryContainersContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [summaries, visuals] = await Promise.all([
    listInventoryContainers(),
    listInventoryContainerVisuals(),
  ]);
  const { editableVisuals, visualPresets } = visuals;
  const requestedView = Array.isArray(params.view)
    ? params.view[0]
    : params.view;
  const urlView: ContainerView | undefined =
    requestedView === "scroll" || requestedView === "bento"
      ? requestedView
      : undefined;
  const requestedDebugBounds = Array.isArray(params.debugBounds)
    ? params.debugBounds[0]
    : params.debugBounds;
  const boundsByKey = new Map(
    editableVisuals.map((visual) => [visual.key, visual.bounds]),
  );
  const hoverBoundsByKey = new Map(
    editableVisuals.map((visual) => [visual.key, visual.hoverBounds]),
  );
  const containers: ContainerShelf[] = summaries.map((container) => ({
    hoverBounds:
      hoverBoundsByKey.get(container.visualPreset.id) ??
      container.visualPreset.bounds,
    id: container.id,
    itemCount: container.itemCount,
    items: container.sampleItems ?? [],
    location: container.locationName ?? "Unplaced",
    name: container.name,
    referenceId: container.referenceId,
    visualPreset: {
      ...container.visualPreset,
      bounds:
        boundsByKey.get(container.visualPreset.id) ??
        container.visualPreset.bounds,
    },
    visualPresetKey: container.visualPresetKey,
  }));

  return (
    <ContainersClient
      containers={containers}
      createAction={createInventoryContainerAction}
      debugBounds={requestedDebugBounds === "1"}
      layoutSeed={crypto.randomUUID()}
      urlView={urlView}
      visualPresets={visualPresets.map((preset) => ({
        id: preset.id,
        isDefault: preset.isDefault,
        name: preset.name,
      }))}
    />
  );
}
