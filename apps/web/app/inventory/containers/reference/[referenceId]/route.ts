import { inventoryContainerReferenceRouteResponse } from "./response";
import { normalizeInventoryContainerReferenceId } from "@/lib/inventory-container-reference";
import {
  isApiAuthenticationError,
  isApiNotFoundError,
  resolveInventoryContainerByReference,
} from "@/lib/quantself-api-client";

type ReferenceRouteContext = {
  params: Promise<{ referenceId: string }>;
};

export async function GET(request: Request, context: ReferenceRouteContext) {
  const { referenceId } = await context.params;
  const normalizedReferenceId =
    normalizeInventoryContainerReferenceId(referenceId);

  try {
    return await inventoryContainerReferenceRouteResponse(
      request,
      normalizedReferenceId,
      resolveInventoryContainerByReference,
    );
  } catch (error) {
    if (isApiAuthenticationError(error)) {
      return new Response("Owner access unavailable.", {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (isApiNotFoundError(error)) {
      return new Response("Container not found.", { status: 404 });
    }

    throw error;
  }
}
