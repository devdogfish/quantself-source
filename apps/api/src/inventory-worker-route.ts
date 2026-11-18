import { prisma } from "@quantself/db";
import { originalFiles, isOriginalReference } from "./original-files";
import { OriginalStorageError } from "./original-storage";
import { authenticateInventoryPreprocessingRequest } from "./inventory-preprocessing-route-handlers";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  authenticateInventoryEnrichmentRequest,
  handleInventoryEnrichmentClaim,
  handleInventoryEnrichmentFailure,
  handleInventoryEnrichmentSuccess,
} from "./inventory-enrichment-route-handlers";
import {
  handleInventoryPreprocessingClaim,
  handleInventoryPreprocessingFailure,
  handleInventoryPreprocessingSuccess,
} from "./inventory-preprocessing-route-handlers";
import { inventoryImageFileResponse } from "./inventory-image-response";
import {
  getInventoryImageFile,
  inventoryRepository,
} from "./inventory-prisma-repository";

export type InventoryWorkerRouteHandlers = {
  claimEnrichment: (request: Request) => Promise<Response>;
  claimPreprocessing: (request: Request) => Promise<Response>;
  getEnrichmentImage: (request: Request, imageId: string) => Promise<Response>;
  submitEnrichmentFailure: (request: Request, jobId: string) => Promise<Response>;
  submitEnrichmentSuccess: (request: Request, jobId: string) => Promise<Response>;
  submitPreprocessingFailure: (request: Request, jobId: string) => Promise<Response>;
  submitPreprocessingSuccess: (request: Request, jobId: string) => Promise<Response>;
};

export const inventoryWorkerRouteHandlers: InventoryWorkerRouteHandlers = {
  async claimEnrichment(request) {
    return handleInventoryEnrichmentClaim(request, inventoryRepository);
  },
  async claimPreprocessing(request) {
    return handleInventoryPreprocessingClaim(request, inventoryRepository);
  },
  async getEnrichmentImage(request, imageId) {
    const authResponse = authenticateInventoryEnrichmentRequest(request);

    if (authResponse) {
      return authResponse;
    }

    const image = await getInventoryImageFile(imageId);

    if (!image) {
      return new Response("Not found", { status: 404 });
    }

    try {
      return await inventoryImageFileResponse(image, {
        cacheControl: "private, max-age=300",
      });
    } catch (error) {
      if (error instanceof OriginalStorageError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
      return new Response("Not found", { status: 404 });
    }
  },
  async submitEnrichmentFailure(request, jobId) {
    return handleInventoryEnrichmentFailure(request, inventoryRepository, jobId);
  },
  async submitEnrichmentSuccess(request, jobId) {
    return handleInventoryEnrichmentSuccess(request, inventoryRepository, jobId);
  },
  async submitPreprocessingFailure(request, jobId) {
    return handleInventoryPreprocessingFailure(request, inventoryRepository, jobId);
  },
  async submitPreprocessingSuccess(request, jobId) {
    return handleInventoryPreprocessingSuccess(request, inventoryRepository, jobId);
  },
};

export function registerInventoryWorkerRoutes(
  app: OpenAPIHono<any>,
  handlers: InventoryWorkerRouteHandlers,
) {
  app.get("/api/internal/inventory/preprocessing/originals/:reference", async context => {
    const denied = authenticateInventoryPreprocessingRequest(context.req.raw);
    if (denied) return denied;
    const reference = context.req.param("reference");
    if (!isOriginalReference(reference)) return context.text("Not found", 404);
    const matches = await Promise.all([
      prisma.inventoryItemImage.findFirst({ where: { filePath: reference }, select: { id: true } }),
      prisma.inventoryItemAudio.findFirst({ where: { filePath: reference }, select: { id: true } }),
      prisma.inventoryItemAsset.findFirst({ where: { filePath: reference }, select: { id: true } }),
    ]);
    if (!matches.some(Boolean)) return context.text("Not found", 404);
    return originalFiles.open(reference, context.req.header("range"));
  });
  app.post("/api/internal/inventory/preprocessing/jobs/claim", (context) =>
    handlers.claimPreprocessing(context.req.raw),
  );

  app.post("/api/internal/inventory/preprocessing/jobs/:jobId/success", (context) => {
    const jobId = context.req.param("jobId");

    if (!jobId) {
      return context.text("Not found", 404);
    }

    return handlers.submitPreprocessingSuccess(context.req.raw, jobId);
  });

  app.post("/api/internal/inventory/preprocessing/jobs/:jobId/failure", (context) => {
    const jobId = context.req.param("jobId");

    if (!jobId) {
      return context.text("Not found", 404);
    }

    return handlers.submitPreprocessingFailure(context.req.raw, jobId);
  });

  app.post("/api/internal/inventory/enrichment/jobs/claim", (context) =>
    handlers.claimEnrichment(context.req.raw),
  );

  app.post("/api/internal/inventory/enrichment/jobs/:jobId/success", (context) => {
    const jobId = context.req.param("jobId");

    if (!jobId) {
      return context.text("Not found", 404);
    }

    return handlers.submitEnrichmentSuccess(context.req.raw, jobId);
  });

  app.post("/api/internal/inventory/enrichment/jobs/:jobId/failure", (context) => {
    const jobId = context.req.param("jobId");

    if (!jobId) {
      return context.text("Not found", 404);
    }

    return handlers.submitEnrichmentFailure(context.req.raw, jobId);
  });

  app.get("/api/internal/inventory/enrichment/images/:imageId", (context) => {
    const imageId = context.req.param("imageId");

    if (!imageId) {
      return context.text("Not found", 404);
    }

    return handlers.getEnrichmentImage(context.req.raw, imageId);
  });
}
