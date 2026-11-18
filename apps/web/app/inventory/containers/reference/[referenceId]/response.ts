import { NextResponse } from "next/server";
import { normalizeInventoryContainerReferenceId } from "@/lib/inventory-container-reference";
import { resolvePublicRequestOrigin } from "@/lib/request-origin";

type ContainerReferenceLookup = (
  referenceId: string,
) => Promise<{ id: string } | null>;

export async function inventoryContainerReferenceRouteResponse(
  request: Request,
  referenceId: string,
  getContainerByReferenceId: ContainerReferenceLookup,
) {
  const normalizedReferenceId =
    normalizeInventoryContainerReferenceId(referenceId);
  const container = await getContainerByReferenceId(normalizedReferenceId);

  if (!container) {
    return new Response("Container not found.", { status: 404 });
  }

  return NextResponse.redirect(
    new URL(
      `/inventory/containers/${encodeURIComponent(container.id)}`,
      resolvePublicRequestOrigin(request),
    ),
  );
}
