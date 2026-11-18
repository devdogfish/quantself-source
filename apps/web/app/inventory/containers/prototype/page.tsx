import { listInventoryContainers } from "@/lib/quantself-api-client";
import { Suspense } from "react";
import {
  pickPresetId,
  PRESET_IDS,
  type PrototypeContainer,
} from "./mock-data";
import { PrototypeClient } from "./prototype-client";
import ContainerPrototypeLoading from "./loading";

type PrototypePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

export default function ContainerPrototypePage({
  searchParams,
}: PrototypePageProps) {
  return (
    <Suspense fallback={<ContainerPrototypeLoading />}>
      <ContainerPrototypeContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ContainerPrototypeContent({
  searchParams,
}: PrototypePageProps) {
  const params = await searchParams;
  const summaries = await listInventoryContainers();
  const requestedVariant = Array.isArray(params.variant)
    ? params.variant[0]
    : params.variant;
  const variant =
    requestedVariant === "c" || requestedVariant === "d"
      ? requestedVariant
      : "a";
  const requestedEffect = Array.isArray(params.effect)
    ? params.effect[0]
    : params.effect;
  const effect = requestedEffect === "blur" ? "blur" : "fade";

  return (
    <PrototypeClient
      containers={buildPrototypeContainers(summaries)}
      initialEffect={effect}
      initialVariant={variant}
    />
  );
}

function buildPrototypeContainers(
  summaries: Awaited<ReturnType<typeof listInventoryContainers>>,
): PrototypeContainer[] {
  const containers: PrototypeContainer[] = summaries.map((container, index) => ({
    id: container.id,
    itemCount: container.itemCount,
    items: container.sampleItems,
    location: container.locationName ?? "Unplaced",
    name: container.name,
    presetFitCheck: false,
    presetId: pickPresetId(container.sizeLiters, index),
    referenceId: container.referenceId,
    sourceContainerId: container.id,
  }));

  if (containers.length === 0) return [];

  const usedPresets = new Set(containers.map((container) => container.presetId));
  const source =
    containers.toSorted((left, right) => right.itemCount - left.itemCount)[0];

  for (const presetId of PRESET_IDS) {
    if (usedPresets.has(presetId)) continue;

    containers.push({
      ...source,
      id: `${source.id}-${presetId.toLocaleLowerCase()}-fit-check`,
      name: `${source.name} · ${presetId} fit check`,
      presetFitCheck: true,
      presetId,
    });
  }

  return containers;
}
