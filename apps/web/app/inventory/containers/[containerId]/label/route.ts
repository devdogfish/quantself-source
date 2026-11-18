import { inventoryContainerLabelRouteResponse } from "./response";
import {
  getInventoryContainer,
  isApiAuthenticationError,
  isApiNotFoundError,
} from "@/lib/quantself-api-client";

type LabelRouteContext = {
  params: Promise<{ containerId: string }>;
};

export async function GET(request: Request, context: LabelRouteContext) {
  const { containerId } = await context.params;

  try {
    return await inventoryContainerLabelRouteResponse(
      request,
      containerId,
      async (id) => {
        const container = await getInventoryContainer(id);

        return {
          name: container.name,
          referenceId: container.referenceId,
        };
      },
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
