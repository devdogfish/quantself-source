import { BoundsFrame } from "./bounds-frame";
import type { Metadata } from "next";
import { Suspense } from "react";
import { listInventoryContainerVisuals } from "@/lib/quantself-api-client";
import { ContainerBoundsEditor } from "./container-bounds-editor";
import ContainerBoundsLoading from "./loading";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Container bounds · Quantself",
};

export default function ContainerBoundsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <BoundsFrame>
      <Suspense fallback={<ContainerBoundsLoading contentOnly />}>
        <ContainerBoundsContent searchParams={searchParams} />
      </Suspense>
    </BoundsFrame>
  );
}

async function ContainerBoundsContent({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const paramsPromise: Promise<Record<string, string | string[] | undefined>> =
    searchParams ?? Promise.resolve({});
  const params = await paramsPromise;
  const { editableVisuals: visuals } = await listInventoryContainerVisuals();
  const requestedPreset = Array.isArray(params.preset)
    ? params.preset[0]
    : params.preset;
  const initialSelectedKey = visuals.some(
    (visual) => visual.key === requestedPreset,
  )
    ? requestedPreset
    : visuals[0]?.key;

  return (
    <ContainerBoundsEditor
      initialSelectedKey={initialSelectedKey}
      visuals={visuals}
    />
  );
}
