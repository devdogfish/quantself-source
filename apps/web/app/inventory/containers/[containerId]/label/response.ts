import {
  buildInventoryContainerReferenceUrl,
  DEFAULT_INVENTORY_CONTAINER_LABEL_DESIGN,
  generateInventoryContainerLabelPdf,
  INVENTORY_CONTAINER_LABEL_DESIGNS,
  type InventoryContainerLabelDesign,
} from "@/lib/inventory-container-label";
import { resolvePublicRequestOrigin } from "@/lib/request-origin";

type LabelContainerLookup = (
  containerId: string,
) => Promise<{ name: string; referenceId: string } | null>;

export async function inventoryContainerLabelRouteResponse(
  request: Request,
  containerId: string,
  getContainer: LabelContainerLookup,
) {
  const requestUrl = new URL(request.url);
  const requestedDesign = requestUrl.searchParams.get("design");

  let design: InventoryContainerLabelDesign =
    DEFAULT_INVENTORY_CONTAINER_LABEL_DESIGN;

  if (requestedDesign) {
    if (!isLabelDesign(requestedDesign)) {
      return new Response("Unknown label design.", { status: 400 });
    }

    design = requestedDesign;
  }
  const container = await getContainer(containerId);

  if (!container) {
    return new Response("Container not found.", { status: 404 });
  }

  const qrUrl = buildInventoryContainerReferenceUrl(
    resolvePublicRequestOrigin(request),
    container.referenceId,
  );
  const pdf = await generateInventoryContainerLabelPdf({
    containerName: container.name,
    design,
    qrUrl,
    referenceId: container.referenceId,
  });
  const shouldDownload = requestUrl.searchParams.get("download") === "1";
  const designSuffix =
    design === DEFAULT_INVENTORY_CONTAINER_LABEL_DESIGN ? "" : `-${design}`;

  return new Response(Buffer.from(pdf), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `${shouldDownload ? "attachment" : "inline"}; filename="${safeFilename(
        container.referenceId,
      )}-label${designSuffix}.pdf"`,
      "Content-Type": "application/pdf",
    },
  });
}

function isLabelDesign(value: string): value is InventoryContainerLabelDesign {
  return (INVENTORY_CONTAINER_LABEL_DESIGNS as readonly string[]).includes(
    value,
  );
}

function safeFilename(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-z0-9_-]+/giu, "-")
      .replace(/^-+|-+$/gu, "") || "container"
  );
}
