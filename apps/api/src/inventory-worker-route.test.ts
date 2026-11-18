import { describe, expect, it } from "bun:test";
import { createApp } from "./app";

describe("private inventory worker routes", () => {
  it("registers internal worker protocol routes outside public OpenAPI", async () => {
    const calls: string[] = [];
    const app = createApp({
      emitAccessLog: () => {},
      inventoryWorkers: {
        claimEnrichment: async () => {
          calls.push("claimEnrichment");
          return Response.json({ jobs: [] });
        },
        getEnrichmentImage: async (_request, imageId) => {
          calls.push(`getEnrichmentImage:${imageId}`);
          return new Response("image-bytes", {
            headers: { "content-type": "image/jpeg" },
            status: 200,
          });
        },
      },
      resolveAccessContext: async () => null,
    });

    const claimResponse = await app.request(
      "/api/internal/inventory/enrichment/jobs/claim",
      {
        body: JSON.stringify({ limit: 1, leaseSeconds: 45, workerId: "worker-1" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const imageResponse = await app.request(
      "/api/internal/inventory/enrichment/images/image-1",
    );
    const openapiResponse = await app.request("/api/openapi.json");
    const document = (await openapiResponse.json()) as { paths: Record<string, unknown> };

    expect(claimResponse.status).toBe(200);
    expect(await claimResponse.json()).toEqual({ jobs: [] });
    expect(imageResponse.status).toBe(200);
    expect(await imageResponse.text()).toBe("image-bytes");
    expect(calls).toEqual([
      "claimEnrichment",
      "getEnrichmentImage:image-1",
    ]);
    expect(document.paths["/api/internal/inventory/enrichment/jobs/claim"]).toBeUndefined();
    expect(
      document.paths["/api/internal/inventory/enrichment/images/{imageId}"],
    ).toBeUndefined();
  });

  it("keeps worker traffic and credentials on the internal API boundary", async () => {
    const [baseCompose, productionCompose, caddyfile] = await Promise.all([
      Bun.file(new URL("../../../compose.yaml", import.meta.url)).text(),
      Bun.file(new URL("../../../compose.prod.yaml", import.meta.url)).text(),
      Bun.file(new URL("../../../Caddyfile", import.meta.url)).text(),
    ]);
    const baseApp = serviceBlock(baseCompose, "app", "api");
    const baseApi = serviceBlock(baseCompose, "api", "gateway");
    const productionApi = serviceBlock(productionCompose, "api", "gateway");
    const preprocessingWorker = serviceBlock(
      productionCompose,
      "inventory-preprocessing-worker",
      "inventory-codex-enrichment-worker",
    );
    const enrichmentWorker = serviceBlock(
      productionCompose,
      "inventory-codex-enrichment-worker",
      "postgres",
    );

    expect(baseApp).not.toContain("INVENTORY_PREPROCESSING_WORKER_SECRET");
    expect(baseApp).not.toContain("INVENTORY_ENRICHMENT_WORKER_SECRET");
    expect(baseApi).toContain("INVENTORY_PREPROCESSING_WORKER_SECRET");
    expect(baseApi).toContain("INVENTORY_ENRICHMENT_WORKER_SECRET");
    expect(productionApi).toContain("INVENTORY_PREPROCESSING_WORKER_SECRET");
    expect(productionApi).toContain("INVENTORY_ENRICHMENT_WORKER_SECRET");
    expect(preprocessingWorker).toContain(
      "INVENTORY_PREPROCESSING_WORKER_BASE_URL: http://api:3001",
    );
    expect(preprocessingWorker).toMatch(/depends_on:\s+api:/u);
    expect(enrichmentWorker).toContain(
      "INVENTORY_ENRICHMENT_WORKER_BASE_URL: http://api:3001",
    );
    expect(enrichmentWorker).toMatch(/depends_on:\s+api:/u);
    expect(caddyfile).toContain(
      "@internal path /api/internal /api/internal/*",
    );
    expect(caddyfile.indexOf("handle @internal")).toBeLessThan(
      caddyfile.indexOf("handle @api"),
    );
    expect(caddyfile).toMatch(/handle @internal \{\s+respond 404\s+\}/u);
  });
});

function serviceBlock(
  compose: string,
  service: string,
  nextService: string,
): string {
  const match = new RegExp(
    `\\n  ${service}:\\n[\\s\\S]*?\\n  ${nextService}:`,
    "u",
  ).exec(compose)?.[0];

  if (!match) {
    throw new Error(`Compose service ${service} is missing.`);
  }

  return match;
}
