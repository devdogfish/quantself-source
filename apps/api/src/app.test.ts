import { authorizeAccessContext, resolveAccessContext, resolveApiKeyPermissions, type AccessContext } from "@quantself/auth";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { createApp } from "./app";
import { jsonAuthorizationFailure } from "./authorization-response";
import { getOpenAPIDocument } from "./openapi";

const HTTP_METHODS = [
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

type PublicOperation = {
  description?: string;
  operationId?: string;
  requestBody?: { required?: boolean };
  responses?: Record<string, { description?: string }>;
  security?: Array<Record<string, string[]>>;
  tags?: string[];
  "x-destructive"?: boolean;
  "x-quantself-destructive"?: boolean;
  "x-quantself-required-permissions"?: string[];
  "x-quantself-required-scopes"?: string[];
  "x-required-permissions"?: string[];
  "x-required-scopes"?: string[];
};

type PublicPathItem = Partial<Record<HttpMethod, PublicOperation>>;
const privateReceipts = "/api/v1/budgeting/receipts";

function buildInventoryItem(input: {
  archivedAt?: string | null;
  captureText?: string | null;
  category?: string | null;
  id: string;
  imageId?: string | null;
  placements: Array<{
    containerId?: string | null;
    label: string;
    locationId?: string | null;
    locationName?: string | null;
    note?: string | null;
    placementId?: string;
    quantity: number;
  }>;
  title: string;
  totalQuantity: number;
}): any {
  return {
    acquisitionSource: null,
    aliases: [],
    archivedAt: input.archivedAt ?? null,
    captureText: input.captureText ?? null,
    capturedAt: "2026-07-28T12:00:00.000Z",
    category: input.category ?? null,
    clothingProfile: null,
    remedyProfile: null,
    containerId: input.placements[0]?.containerId ?? null,
    containerLabel: input.placements[0]?.label ?? null,
    costCents: null,
    costCurrency: "CAD",
    id: input.id,
    imageId: input.imageId ?? null,
    importance: "MEDIUM" as const,
    kind: "GROUP" as const,
    note: null,
    placementSummary: `Total ${input.totalQuantity} · ${input.placements
      .map((placement) => `${placement.label} ${placement.quantity}`)
      .join(" · ")}`,
    placements: input.placements.map((placement, index) => ({
      containerId: placement.containerId ?? null,
      label: placement.label,
      locationId: placement.locationId ?? null,
      locationName: placement.locationName ?? null,
      note: placement.note ?? null,
      placementId: placement.placementId ?? `placement-${index + 1}`,
      quantity: placement.quantity,
    })),
    processing: {
      currentStep: "Wait for background processing",
      enrichment: {
        rationale: "Inventory Enrichment has not started.",
        status: "NOT_STARTED" as const,
        summary: "Inventory Enrichment has not started.",
        updatedAt: "2026-07-28T12:00:00.000Z",
      },
      evidence: [],
      nextAction: "Wait for background processing",
      preprocessing: {
        failedSteps: [],
        mediaTexts: [],
        status: "CAPTURED" as const,
        summary: "Saved evidence is waiting for preprocessing pickup.",
        textBundleAvailable: false,
        updatedAt: "2026-07-28T12:00:00.000Z",
      },
      proposal: {
        status: "NONE" as const,
        summary: "No pending Inventory Proposal.",
        updatedAt: "2026-07-28T12:00:00.000Z",
      },
      sourceLabel: "Inventory capture",
    },
    status: "UNSURE" as const,
    tags: [],
    title: input.title,
    totalQuantity: input.totalQuantity,
    where: input.placements[0]?.label ?? "Unplaced",
  };
}

describe("QuantSelf API baseline", () => {
  // Exercise the full contract on the shared app and on the explicit validation tests.
  const createQuietApp = (options: Parameters<typeof createApp>[0] = {}) =>
    createApp({
      emitAccessLog: () => {},
      unsafeSkipContractValidationForTests: true,
      ...options,
    });
  const app = createQuietApp({
    resolveAccessContext: async () => null,
    unsafeSkipContractValidationForTests: false,
  });

  it("reports independent API health", async () => {
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "quantself-api",
      status: "ok",
    });
  });

  it("serves a live OpenAPI 3.1 contract", async () => {
    const response = await app.request("/api/openapi.json");
    const responseBody = await response.text();
    const document = JSON.parse(responseBody) as {
      components?: {
        securitySchemes?: Record<string, { scheme?: string; type?: string }>;
      };
      openapi: string;
      paths: Record<string, PublicPathItem>;
    };
    const documentedOperations = Object.entries(document.paths)
      .filter(([path]) => path.startsWith("/api/v1/"))
      .flatMap(([path, pathItem]) =>
        HTTP_METHODS.filter((method) => pathItem[method]).map((method) => ({
          method,
          operation: pathItem[method]!,
          path,
        })),
      );
    const runtimeOperations = [
      ...new Set(
        app.routes
          .filter(
            ({ method, path }) =>
              path.startsWith("/api/v1/") &&
              path !== privateReceipts && !path.startsWith(privateReceipts + "/") &&
              !(method === "ALL" && path === "/api/v1/*"),
          )
          .map(
            ({ method, path }) =>
              `${method.toLowerCase()} ${path.replaceAll(/:([^/]+)/g, "{$1}")}`,
          ),
      ),
    ].sort();
    const accessContext = document.paths["/api/v1/access-context"]?.get;

    expect(response.status).toBe(200);
    expect(document.openapi).toBe("3.1.1");
    expect(
      documentedOperations
        .map(({ method, path }) => `${method} ${path}`)
        .sort(),
    ).toEqual(runtimeOperations);
    for (const { operation } of documentedOperations) {
      expect(typeof operation["x-destructive"]).toBe("boolean");
      expect(Array.isArray(operation["x-required-permissions"])).toBe(true);
    }
    expect(responseBody).not.toContain('"x-quantself-required-');
    expect(responseBody).not.toContain('"x-required-scopes"');
    expect(document.paths["/api/auth/ok"]).toBeUndefined();
    expect(accessContext?.operationId).toBe("getAccessContext");
    expect(accessContext?.security).toEqual([
      { apiKeyAuth: [] },
      { ownerSession: [] },
    ]);
    expect(accessContext?.tags).toEqual(["Auth"]);
    expect(accessContext?.["x-destructive"]).toBe(false);
    expect(accessContext?.["x-required-permissions"]).toEqual([]);
    expect(accessContext?.["x-quantself-destructive"]).toBeUndefined();
    expect(accessContext?.["x-quantself-required-permissions"]).toBeUndefined();
    expect(accessContext?.["x-required-scopes"]).toBeUndefined();
    expect(accessContext?.["x-quantself-required-scopes"]).toBeUndefined();
    expect(accessContext?.responses?.["200"]?.description).toBe(
      "Current authenticated access context.",
    );
    expect(accessContext?.responses?.["401"]?.description).toBe(
      "No valid Owner ingress proof or API Key was provided.",
    );
    expect(accessContext?.description).toContain("Required permissions: none.");
    expect(document.components?.securitySchemes?.apiKeyAuth).toMatchObject({
      in: "header",
      name: "X-API-Key",
      type: "apiKey",
    });
    expect(document.components?.securitySchemes?.ownerSession).toMatchObject({
      in: "header",
      name: "X-Quantself-Owner-Proof",
      type: "apiKey",
    });
  });

  it("documents inventory processing, proposal, and enrichment preference routes", async () => {
    const response = await app.request("/api/openapi.json");
    const document = (await response.json()) as {
      components?: {
        schemas?: Record<string, { properties?: Record<string, unknown> }>;
      };
      paths: Record<string, PublicPathItem>;
    };
    const itemSchema = document.components?.schemas?.InventoryItem;
    const itemProperties = itemSchema?.properties ?? {};

    expect(
      document.paths["/api/v1/inventory-enrichment-settings"]?.get?.operationId,
    ).toBe("getInventoryEnrichmentSettings");
    expect(
      document.paths["/api/v1/inventory-enrichment-settings"]?.put?.operationId,
    ).toBe("updateInventoryEnrichmentSettings");
    expect(
      document.paths["/api/v1/inventory-proposals"]?.get?.operationId,
    ).toBe("listInventoryProposals");
    expect(
      document.paths["/api/v1/inventory-proposals/{proposalId}/approve"]?.post
        ?.operationId,
    ).toBe("approveInventoryProposal");
    expect(
      document.paths["/api/v1/inventory-proposals/{proposalId}/reject"]?.post
        ?.operationId,
    ).toBe("rejectInventoryProposal");
    expect(itemProperties).toHaveProperty("processing");
    expect(itemProperties).toHaveProperty("where");
    expect(itemProperties).toHaveProperty("placementSummary");
    expect(itemProperties).toHaveProperty("capturedAt");
  });

  it("documents Remedy Intake mutation requirements and deletion conflicts", async () => {
    const response = await app.request("/api/openapi.json");
    const document = (await response.json()) as {
      paths: Record<string, PublicPathItem>;
    };
    const remedyIntakeCreate =
      document.paths["/api/v1/remedy-intakes"]?.post;
    const remedyIntakeList = document.paths["/api/v1/remedy-intakes"]?.get;
    const remedyIntakeSummary =
      document.paths["/api/v1/remedy-intakes/summary"]?.get;
    const archiveItem =
      document.paths["/api/v1/inventory-items/{itemId}/archive"]?.post;
    const deleteItem =
      document.paths["/api/v1/inventory-items/{itemId}"]?.delete;

    expect(remedyIntakeCreate?.requestBody?.required).toBe(true);
    expect(remedyIntakeCreate?.["x-required-permissions"]).toEqual([
      "health:write",
      "inventory:read",
    ]);
    expect(remedyIntakeList?.operationId).toBe("listRemedyIntakes");
    expect(remedyIntakeList?.responses?.["400"]).toBeDefined();
    expect(remedyIntakeSummary?.operationId).toBe("summarizeRemedyIntakes");
    expect(remedyIntakeSummary?.["x-required-permissions"]).toEqual([
      "health:read",
      "inventory:read",
    ]);
    expect(archiveItem?.responses?.["409"]).toBeUndefined();
    expect(archiveItem?.description).toContain(
      "deactivates a linked remedy Substance",
    );
    expect(deleteItem?.responses?.["409"]?.description).toBe(
      "Historical Remedy Intake data blocks permanent deletion.",
    );
  });

  it("enforces Inventory permissions and forwards proposal/settings commands", async () => {
    const proposal = {
      captureText: "Passport and charger.",
      capturedAt: "2026-07-28T08:50:00.000Z",
      confidence: 0.94,
      diff: [
        {
          current: "Black pouch",
          field: "title",
          label: "Title",
          proposed: "Passport pouch",
        },
      ],
      failedSteps: [],
      id: "job-1",
      ocrEvidence: [],
      itemId: "item-1",
      itemTitle: "Black pouch",
      rationale: "OCR mentions passport.",
      sourceRefsSummary: "1 item, 1 image, 0 audio, 0 file",
      transcriptEvidence: [],
      updatedAt: "2026-07-28T09:00:00.000Z",
    };
    const listCalls: Array<{ limit: number; itemId: string | null }> = [];
    const commandCalls: Array<Record<string, unknown>> = [];
    const inventoryItems = {
      approveProposal: async (input: Record<string, unknown>) => {
        commandCalls.push(input);
        return {
          proposal: {
            decidedAt: "2026-07-28T09:05:00.000Z",
            id: "job-1",
            itemId: "item-1",
            status: "APPLIED" as const,
          },
        };
      },
      getEnrichmentSettings: async () => ({
        approvalsRequired: true,
        updatedAt: "2026-07-28T09:00:00.000Z",
      }),
      listProposals: async (input: {
        limit: number;
        itemId: string | null;
      }) => {
        listCalls.push(input);
        return [proposal];
      },
      rejectProposal: async (input: Record<string, unknown>) => {
        commandCalls.push(input);
        return {
          proposal: {
            decidedAt: "2026-07-28T09:06:00.000Z",
            id: "job-1",
            itemId: "item-1",
            status: "REJECTED" as const,
          },
        };
      },
      updateEnrichmentSettings: async (input: {
        clientId: string;
        idempotencyKey: string;
        operation: string;
        request: { approvalsRequired: boolean };
      }) => {
        commandCalls.push(input);
        return {
          settings: {
            approvalsRequired: input.request.approvalsRequired,
            updatedAt: "2026-07-28T09:01:00.000Z",
          },
        };
      },
    };
    const accessContext = (
      permissions: AccessContext["permissions"],
    ): AccessContext => ({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-client",
      },
      permissions,
    });
    const fullAccessApp = createQuietApp({
      inventoryItems,
      resolveAccessContext: async () =>
        accessContext(["inventory:read", "inventory:write"]),
    });
    const readOnlyApp = createQuietApp({
      inventoryItems,
      resolveAccessContext: async () => accessContext(["inventory:read"]),
    });
    const writeOnlyApp = createQuietApp({
      inventoryItems,
      resolveAccessContext: async () => accessContext(["inventory:write"]),
    });
    const headers = { "x-api-key": "qs_test_credential" };

    const settingsResponse = await fullAccessApp.request(
      "/api/v1/inventory-enrichment-settings",
      { headers },
    );
    const proposalsResponse = await fullAccessApp.request(
      "/api/v1/inventory-proposals?itemId=item-1&limit=1",
      { headers },
    );
    const updateResponse = await fullAccessApp.request(
      "/api/v1/inventory-enrichment-settings",
      {
        body: JSON.stringify({ approvalsRequired: false }),
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": "settings-1",
        },
        method: "PUT",
      },
    );
    const approveResponse = await fullAccessApp.request(
      "/api/v1/inventory-proposals/job-1/approve",
      {
        headers: { ...headers, "idempotency-key": "approve-1" },
        method: "POST",
      },
    );
    const rejectResponse = await fullAccessApp.request(
      "/api/v1/inventory-proposals/job-1/reject",
      {
        headers: { ...headers, "idempotency-key": "reject-1" },
        method: "POST",
      },
    );
    const forbiddenReadResponse = await writeOnlyApp.request(
      "/api/v1/inventory-proposals",
      { headers },
    );
    const forbiddenWriteResponse = await readOnlyApp.request(
      "/api/v1/inventory-proposals/job-1/approve",
      {
        headers: { ...headers, "idempotency-key": "approve-2" },
        method: "POST",
      },
    );
    const blankItemResponse = await fullAccessApp.request(
      "/api/v1/inventory-proposals?itemId=%20",
      { headers },
    );

    expect(settingsResponse.status).toBe(200);
    expect(await settingsResponse.json()).toEqual({
      settings: {
        approvalsRequired: true,
        updatedAt: "2026-07-28T09:00:00.000Z",
      },
    });
    expect(proposalsResponse.status).toBe(200);
    expect(await proposalsResponse.json()).toEqual({ proposals: [proposal] });
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toEqual({
      settings: {
        approvalsRequired: false,
        updatedAt: "2026-07-28T09:01:00.000Z",
      },
    });
    expect(approveResponse.status).toBe(200);
    expect(
      ((await approveResponse.json()) as { proposal: { status: string } })
        .proposal.status,
    ).toBe("APPLIED");
    expect(rejectResponse.status).toBe(200);
    expect(
      ((await rejectResponse.json()) as { proposal: { status: string } })
        .proposal.status,
    ).toBe("REJECTED");
    expect(forbiddenReadResponse.status).toBe(403);
    expect(forbiddenWriteResponse.status).toBe(403);
    expect(blankItemResponse.status).toBe(400);
    expect(listCalls).toEqual([{ limit: 1, itemId: "item-1" }]);
    expect(commandCalls).toEqual([
      {
        clientId: "api-key-1",
        idempotencyKey: "settings-1",
        operation: "updateInventoryEnrichmentSettings",
        request: { approvalsRequired: false },
      },
      {
        clientId: "api-key-1",
        idempotencyKey: "approve-1",
        operation: "approveInventoryProposal",
        proposalId: "job-1",
      },
      {
        clientId: "api-key-1",
        idempotencyKey: "reject-1",
        operation: "rejectInventoryProposal",
        proposalId: "job-1",
      },
    ]);
  });

  it("does not mount browser auth, bootstrap, or passkey management", async () => {
    for (const [method, path] of [
      ["GET", "/api/auth/ok"],
      ["GET", "/api/auth/get-session"],
      ["GET", "/api/auth/passkey/generate-register-options"],
      ["POST", "/api/auth/passkey/verify-authentication"],
      ["GET", "/api/owner-setup/state"],
      ["POST", "/api/owner-setup/passkey/options"],
      ["POST", "/api/owner-setup/passkey/verify"],
    ]) {
      expect((await app.request(path, { method })).status).toBe(404);
    }
  });

  it("serves agent and human reference surfaces", async () => {
    const headers = { "x-api-key": "synthetic-scoped-client" };
    const [llms, markdown, scalar, machine] = await Promise.all(
      ["/llms.txt", "/api/reference.md", "/api/reference", "/api/openapi.json"].map(path => app.request(path, { headers })),
    );
    const markdownText = await markdown.text();

    expect(llms.status).toBe(200);
    const llmsText = await llms.text();
    expect(llmsText).toContain("/api/openapi.json");
    expect(llmsText).toContain("Inventory write quick reference");
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(markdownText).toContain("Get current access context");
    expect(markdownText).toContain(
      "Authentication: X-API-Key or trusted Owner ingress.",
    );
    expect(markdownText).toContain("Required permissions: none.");
    expect(markdownText).toContain("Inputs: none.");
    expect(markdownText).toContain(
      "Success response: 200 with owner, client, and effective permissions.",
    );
    expect(markdownText).toContain(
      "Failure responses: 401 when no valid Owner ingress proof or API Key is present.",
    );
    expect(markdownText).toContain("Side effects: none.");
    expect(markdownText).toContain("Destructive: no.");
    expect(markdownText).toContain(
      "Retry safety: safe to repeat and idempotent.",
    );
    expect(markdownText).toContain("Inventory write quick reference");
    expect(markdownText).toContain(
      "Food and supplements have no specialist Profile",
    );
    expect(markdownText).toContain(
      "GET, merge, then PUT the complete Clothing Profile",
    );
    expect(markdownText).toContain("one Inventory Item per remedy");
    expect(markdownText).toContain("no per-potency quantities");
    expect(markdownText).toContain('"email": "owner@example.com"');
    expect(markdownText).toContain('"code": "UNAUTHENTICATED"');
    expect(scalar.status).toBe(200);
    expect(await scalar.text()).toContain(
      "/api/reference-assets/scalar-1.63.0.js",
    );
    expect(machine.status).toBe(200);
    for (const text of [await machine.text(), markdownText]) {
      expect(text).not.toContain(privateReceipts);
      expect(text).not.toContain("BudgetReceipt");
      expect(text).not.toContain("BudgetDocument");
      expect(text).toContain("Get current access context");
    }
  }, 15_000);

  it("rejects undocumented public versioned routes by default", () => {
    expect(() =>
      createApp({
        emitAccessLog: () => {},
        registerRoutes: (protectedApp) => {
          protectedApp.get("/api/v1/test/delete", (context) =>
            context.json({ ok: true }, 200),
          );
        },
        resolveAccessContext: async () => null,
      }),
    ).toThrow(/undocumented public api route/i);
  });

  it("keeps receipt actions in the internal Owner contract", () => {
    const owner = getOpenAPIDocument(app);
    const receiptPaths = Object.entries(owner.paths ?? {}).filter(([path]) =>
      path === privateReceipts || path.startsWith(privateReceipts + "/"),
    );
    const operations = receiptPaths.flatMap(([, path]) => HTTP_METHODS.flatMap(method =>
      path?.[method] ? [path[method]!] : [],
    ));
    expect(operations).toHaveLength(10);
    for (const operation of operations) expect(operation.security).toEqual([{ ownerSession: [] }]);
  });

  it("rejects anonymous access-context requests with a stable JSON error", async () => {
    const response = await app.request("/api/v1/access-context");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
  });

  it("returns the resolved owner access context for access-context", async () => {
    const authenticatedApp = createQuietApp({
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "user-1",
          name: "QuantSelf Owner",
        },
        client: {
          id: "quantself-web",
          kind: "web",
          name: "Quantself Web Client",
        },
        permissions: ["inventory:delete", "inventory:read", "inventory:write"],
      }),
    });

    const response = await authenticatedApp.request("/api/v1/access-context");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "quantself-web",
        kind: "web",
        name: "Quantself Web Client",
      },
      permissions: ["inventory:delete", "inventory:read", "inventory:write"],
    });
  });

  it("returns the resolved API Key Client access context for access-context", async () => {
    const authenticatedApp = createQuietApp({
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "user-1",
          name: "QuantSelf Owner",
        },
        client: {
          id: "api-key-1",
          kind: "api-key",
          name: "inventory-bot",
        },
        permissions: ["inventory:read", "inventory:write"],
      }),
    });

    const response = await authenticatedApp.request("/api/v1/access-context", {
      headers: {
        "x-api-key": "qs_test_credential",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-bot",
      },
      permissions: ["inventory:read", "inventory:write"],
    });
  });

  it("requires Inventory Read before listing and retrieving Inventory Items", async () => {
    const items = [
      buildInventoryItem({
        id: "item-1",
        imageId: "image-1",
        placements: [{ label: "Travel drawer (BIN-0003)", quantity: 2 }],
        title: "Passport pouch",
        totalQuantity: 2,
      }),
      buildInventoryItem({
        archivedAt: "2026-07-26T12:00:00.000Z",
        id: "item-archived",
        placements: [{ label: "Basement tote", quantity: 1 }],
        title: "Projector",
        totalQuantity: 1,
      }),
    ];
    const listCalls: Array<{
      archived: boolean;
      category: string | null;
      query: string | null;
    }> = [];
    const getCalls: string[] = [];
    const createInventoryItemsApp = (accessContext: AccessContext | null) =>
      createQuietApp({
        inventoryItems: {
          archiveItem: async (id: string) => ({
            archivedAt: "2026-07-28T12:00:00.000Z",
            id,
          }),
          deleteItem: async (id: string) => ({
            deletedItemId: id,
          }),
          getItem: async (id: string) => {
            getCalls.push(id);
            return items.find((item) => item.id === id) ?? null;
          },
          listItems: async ({
            archived,
            category,
            query,
          }: {
            archived: boolean;
            category: string | null;
            query: string | null;
          }) => {
            listCalls.push({ archived, category, query });
            const pageItems = archived ? [items[1]!] : [items[0]!];
            return {
              items: pageItems,
              pageInfo: { nextCursor: null },
              total: pageItems.length,
            };
          },
          restoreItem: async (id: string) => ({
            archivedAt: null,
            id,
          }),
        },
        resolveAccessContext: async () => accessContext,
      });
    const anonymousApp = createInventoryItemsApp(null);
    const writeOnlyApp = createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-bot",
      },
      permissions: ["inventory:write"],
    });
    const readApp = createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-2",
        kind: "api-key",
        name: "inventory-reader",
      },
      permissions: ["inventory:read"],
    });

    const anonymousResponse = await anonymousApp.request(
      "/api/v1/inventory-items",
    );
    const anonymousDetailResponse = await anonymousApp.request(
      "/api/v1/inventory-items/item-archived",
    );
    const blankQueryResponse = await readApp.request(
      "/api/v1/inventory-items?archived=true&q=%20%20",
      {
        headers: {
          "x-api-key": "qs_test_credential",
        },
      },
    );
    const searchedResponse = await readApp.request(
      "/api/v1/inventory-items?archived=true&q=projector",
      {
        headers: {
          "x-api-key": "qs_test_credential",
        },
      },
    );
    const forbiddenResponse = await writeOnlyApp.request(
      "/api/v1/inventory-items",
      {
        headers: {
          "x-api-key": "qs_test_credential",
        },
      },
    );
    const forbiddenDetailResponse = await writeOnlyApp.request(
      "/api/v1/inventory-items/item-archived",
      {
        headers: {
          "x-api-key": "qs_test_credential",
        },
      },
    );
    const okResponse = await readApp.request("/api/v1/inventory-items", {
      headers: {
        "x-api-key": "qs_test_credential",
      },
    });
    const detailResponse = await readApp.request(
      "/api/v1/inventory-items/item-archived",
      {
        headers: {
          "x-api-key": "qs_test_credential",
        },
      },
    );
    const missingResponse = await readApp.request(
      "/api/v1/inventory-items/missing",
      {
        headers: {
          "x-api-key": "qs_test_credential",
        },
      },
    );

    expect(anonymousResponse.status).toBe(401);
    expect(await anonymousResponse.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
    expect(anonymousDetailResponse.status).toBe(401);
    expect(await anonymousDetailResponse.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.json()).toEqual({
      code: "FORBIDDEN",
      message: "Missing required permission.",
    });
    expect(forbiddenDetailResponse.status).toBe(403);
    expect(await forbiddenDetailResponse.json()).toEqual({
      code: "FORBIDDEN",
      message: "Missing required permission.",
    });
    expect(okResponse.status).toBe(200);
    expect(await okResponse.json()).toEqual({
      items: [items[0]],
      pageInfo: { nextCursor: null },
      total: 1,
    });
    expect(blankQueryResponse.status).toBe(200);
    expect(await blankQueryResponse.json()).toEqual({
      items: [items[1]],
      pageInfo: { nextCursor: null },
      total: 1,
    });
    expect(searchedResponse.status).toBe(200);
    expect(await searchedResponse.json()).toEqual({
      items: [items[1]],
      pageInfo: { nextCursor: null },
      total: 1,
    });
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toEqual({ item: items[1] });
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      code: "NOT_FOUND",
      message: "Inventory Item not found.",
    });
    expect(listCalls).toEqual([
      { archived: true, category: null, query: null },
      { archived: true, category: null, query: "projector" },
      { archived: false, category: null, query: null },
    ]);
    expect(getCalls).toEqual(["item-archived", "missing"]);
  });

  it("requires combined Health and Inventory permissions for Remedy Intake routes", async () => {
    const intake = {
      id: "intake-1",
      note: "Before bed.",
      occurredAt: "2026-08-03T22:15:00.000Z",
      potency: "200C",
      itemArchivedAt: null,
      itemId: "item-remedy",
      itemTitle: "Arsenicum album",
    };
    const intakeProjection = {
      ...intake,
      bucketDate: "2026-08-03",
      colorKey: "remedy-3",
    };
    const listCalls: Array<Record<string, unknown>> = [];
    const summaryCalls: Array<Record<string, unknown>> = [];
    const createCalls: Array<Record<string, unknown>> = [];
    const deleteCalls: Array<Record<string, unknown>> = [];
    const createInventoryItemsApp = (accessContext: AccessContext | null) =>
      createQuietApp({
        inventoryItems: {
          createRemedyIntake: async (input) => {
            createCalls.push(input as unknown as Record<string, unknown>);
            return { intake };
          },
          deleteRemedyIntake: async (input) => {
            deleteCalls.push(input as unknown as Record<string, unknown>);
            return { deletedIntakeId: input.intakeId };
          },
          listRemedyIntakes: async (input) => {
            listCalls.push(input as unknown as Record<string, unknown>);
            return {
              intakes: [intakeProjection],
              pageInfo: { nextCursor: null },
              range: input.range,
            };
          },
          summarizeRemedyIntakes: async (input) => {
            summaryCalls.push(input as unknown as Record<string, unknown>);
            return { range: input.range, remedies: [], totalIntakes: 0 };
          },
        },
        resolveAccessContext: async () => accessContext,
      });
    const anonymousApp = createInventoryItemsApp(null);
    const healthReadOnlyApp = createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-health",
        kind: "api-key",
        name: "health-reader",
      },
      permissions: ["health:read"],
    });
    const intakeWriterApp = createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-remedy",
        kind: "api-key",
        name: "remedy-writer",
      },
      permissions: [
        "health:delete",
        "health:read",
        "health:write",
        "inventory:read",
      ],
    });

    const anonymousListResponse = await anonymousApp.request(
      "/api/v1/remedy-intakes?range=30d&timeZone=UTC",
    );
    const forbiddenListResponse = await healthReadOnlyApp.request(
      "/api/v1/remedy-intakes?range=30d&timeZone=UTC",
      {
        headers: {
          "x-api-key": "qs_health_reader",
        },
      },
    );
    const okListResponse = await intakeWriterApp.request(
      "/api/v1/remedy-intakes?itemId=item-remedy&range=30d&timeZone=UTC",
      {
        headers: {
          "x-api-key": "qs_remedy_writer",
        },
      },
    );
    const anonymousSummaryResponse = await anonymousApp.request(
      "/api/v1/remedy-intakes/summary?range=30d&timeZone=UTC",
    );
    const forbiddenSummaryResponse = await healthReadOnlyApp.request(
      "/api/v1/remedy-intakes/summary?range=30d&timeZone=UTC",
      { headers: { "x-api-key": "qs_health_reader" } },
    );
    const okSummaryResponse = await intakeWriterApp.request(
      "/api/v1/remedy-intakes/summary?range=30d&timeZone=UTC",
      { headers: { "x-api-key": "qs_remedy_writer" } },
    );
    const forbiddenCreateResponse = await healthReadOnlyApp.request(
      "/api/v1/remedy-intakes",
      {
        body: JSON.stringify({
          potency: "200C",
          itemId: "item-remedy",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "create-remedy-intake-1",
          "x-api-key": "qs_health_reader",
        },
        method: "POST",
      },
    );
    const okCreateResponse = await intakeWriterApp.request(
      "/api/v1/remedy-intakes",
      {
        body: JSON.stringify({
          note: "Before bed.",
          occurredAt: "2026-08-03T22:15:00.000Z",
          potency: "200C",
          itemId: "item-remedy",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "create-remedy-intake-2",
          "x-api-key": "qs_remedy_writer",
        },
        method: "POST",
      },
    );
    const forbiddenDeleteResponse = await createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-delete-missing",
        kind: "api-key",
        name: "missing-health-delete",
      },
      permissions: ["health:read", "inventory:read"],
    }).request("/api/v1/remedy-intakes/intake-1", {
      headers: {
        "idempotency-key": "delete-remedy-intake-1",
        "x-api-key": "qs_missing_health_delete",
      },
      method: "DELETE",
    });
    const okDeleteResponse = await intakeWriterApp.request(
      "/api/v1/remedy-intakes/intake-1",
      {
        headers: {
          "idempotency-key": "delete-remedy-intake-2",
          "x-api-key": "qs_remedy_writer",
        },
        method: "DELETE",
      },
    );

    expect(anonymousListResponse.status).toBe(401);
    expect(await anonymousListResponse.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
    expect(forbiddenListResponse.status).toBe(403);
    expect(await forbiddenListResponse.json()).toEqual({
      code: "FORBIDDEN",
      message: "Missing required permission.",
    });
    expect(okListResponse.status).toBe(200);
    expect(await okListResponse.json()).toEqual({
      intakes: [intakeProjection],
      pageInfo: { nextCursor: null },
      range: "30d",
    });
    expect(anonymousSummaryResponse.status).toBe(401);
    expect(forbiddenSummaryResponse.status).toBe(403);
    expect(okSummaryResponse.status).toBe(200);
    expect(await okSummaryResponse.json()).toEqual({
      range: "30d",
      remedies: [],
      totalIntakes: 0,
    });
    expect(forbiddenCreateResponse.status).toBe(403);
    expect(await forbiddenCreateResponse.json()).toEqual({
      code: "FORBIDDEN",
      message: "Missing required permission.",
    });
    expect(okCreateResponse.status).toBe(201);
    expect(await okCreateResponse.json()).toEqual({ intake });
    expect(forbiddenDeleteResponse.status).toBe(403);
    expect(await forbiddenDeleteResponse.json()).toEqual({
      code: "FORBIDDEN",
      message: "Missing required permission.",
    });
    expect(okDeleteResponse.status).toBe(200);
    expect(await okDeleteResponse.json()).toEqual({
      deletedIntakeId: "intake-1",
    });
    expect(listCalls).toEqual([
      {
        cursor: null,
        itemId: "item-remedy",
        range: "30d",
        timeZone: "UTC",
      },
    ]);
    expect(summaryCalls).toEqual([
      { itemId: null, range: "30d", timeZone: "UTC" },
    ]);
    expect(createCalls).toEqual([
      {
        clientId: "api-key-remedy",
        idempotencyKey: "create-remedy-intake-2",
        operation: "createRemedyIntake",
        request: {
          note: "Before bed.",
          occurredAt: "2026-08-03T22:15:00.000Z",
          potency: "200C",
          itemId: "item-remedy",
        },
      },
    ]);
    expect(deleteCalls).toEqual([
      {
        clientId: "api-key-remedy",
        idempotencyKey: "delete-remedy-intake-2",
        intakeId: "intake-1",
        operation: "deleteRemedyIntake",
      },
    ]);
  });

  it("splits Item lifecycle permissions between write and delete commands", async () => {
    const archiveCalls: string[] = [];
    const restoreCalls: string[] = [];
    const deleteCalls: string[] = [];
    const createInventoryItemsApp = (accessContext: AccessContext | null) =>
      createQuietApp({
        inventoryItems: {
          archiveItem: async (id: string) => {
            archiveCalls.push(id);
            return {
              archivedAt: "2026-07-28T12:00:00.000Z",
              id,
            };
          },
          deleteItem: async (id: string) => {
            deleteCalls.push(id);
            return {
              deletedItemId: id,
            };
          },
          getItem: async () => null,
          listItems: async () => ({
            items: [],
            pageInfo: { nextCursor: null },
            total: 0,
          }),
          restoreItem: async (id: string) => {
            restoreCalls.push(id);
            return {
              archivedAt: null,
              id,
            };
          },
        },
        resolveAccessContext: async () => accessContext,
      });
    const anonymousApp = createInventoryItemsApp(null);
    const writeOnlyApp = createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-writer",
      },
      permissions: ["inventory:write"],
    });
    const deleteOnlyApp = createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-2",
        kind: "api-key",
        name: "inventory-deleter",
      },
      permissions: ["inventory:delete"],
    });

    const anonymousArchiveResponse = await anonymousApp.request(
      "/api/v1/inventory-items/item-1/archive",
      { method: "POST" },
    );
    const writeArchiveResponse = await writeOnlyApp.request(
      "/api/v1/inventory-items/item-1/archive",
      {
        method: "POST",
        headers: {
          "x-api-key": "qs_test_writer",
        },
      },
    );
    const deleteArchiveResponse = await deleteOnlyApp.request(
      "/api/v1/inventory-items/item-1/archive",
      {
        method: "POST",
        headers: {
          "x-api-key": "qs_test_delete",
        },
      },
    );
    const writeRestoreResponse = await writeOnlyApp.request(
      "/api/v1/inventory-items/item-2/restore",
      {
        method: "POST",
        headers: {
          "x-api-key": "qs_test_writer",
        },
      },
    );
    const writeDeleteResponse = await writeOnlyApp.request(
      "/api/v1/inventory-items/item-3",
      {
        method: "DELETE",
        headers: {
          "x-api-key": "qs_test_writer",
        },
      },
    );
    const deleteDeleteResponse = await deleteOnlyApp.request(
      "/api/v1/inventory-items/item-3",
      {
        method: "DELETE",
        headers: {
          "x-api-key": "qs_test_delete",
        },
      },
    );

    expect(anonymousArchiveResponse.status).toBe(401);
    expect(await anonymousArchiveResponse.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
    expect(writeArchiveResponse.status).toBe(200);
    expect(await writeArchiveResponse.json()).toEqual({
      item: {
        archivedAt: "2026-07-28T12:00:00.000Z",
        id: "item-1",
      },
    });
    expect(deleteArchiveResponse.status).toBe(403);
    expect(await deleteArchiveResponse.json()).toEqual({
      code: "FORBIDDEN",
      message: "Missing required permission.",
    });
    expect(writeRestoreResponse.status).toBe(200);
    expect(await writeRestoreResponse.json()).toEqual({
      item: {
        archivedAt: null,
        id: "item-2",
      },
    });
    expect(writeDeleteResponse.status).toBe(403);
    expect(await writeDeleteResponse.json()).toEqual({
      code: "FORBIDDEN",
      message: "Missing required permission.",
    });
    expect(deleteDeleteResponse.status).toBe(200);
    expect(await deleteDeleteResponse.json()).toEqual({
      deletedItemId: "item-3",
    });
    expect(archiveCalls).toEqual(["item-1"]);
    expect(restoreCalls).toEqual(["item-2"]);
    expect(deleteCalls).toEqual(["item-3"]);
  });

  it("requires Inventory Write before updating Item facts through an idempotent API command", async () => {
    const updateCalls: Array<{
      clientId: string;
      idempotencyKey: string;
      operation: string;
      itemId: string;
      request: Record<string, unknown>;
    }> = [];
    const createInventoryItemsApp = (accessContext: AccessContext | null) =>
      createQuietApp({
        inventoryItems: {
          archiveItem: async (id: string) => ({
            archivedAt: "2026-07-28T12:00:00.000Z",
            id,
          }),
          deleteItem: async (id: string) => ({
            deletedItemId: id,
          }),
          getItem: async () => null,
          listItems: async () => ({
            items: [],
            pageInfo: { nextCursor: null },
            total: 0,
          }),
          restoreItem: async (id: string) => ({
            archivedAt: null,
            id,
          }),
          updateItem: async (input) => {
            updateCalls.push({
              clientId: input.clientId,
              idempotencyKey: input.idempotencyKey,
              operation: input.operation,
              itemId: input.itemId,
              request: input.request,
            });

            return {
              item: buildInventoryItem({
                id: input.itemId,
                placements: [
                  { label: "Travel drawer (BIN-0003)", quantity: 2 },
                ],
                title: String(
                  input.request.title ?? "Untitled Inventory Item",
                ),
                totalQuantity: 2,
              }),
            };
          },
        },
        resolveAccessContext: async () => accessContext,
      });
    const anonymousApp = createInventoryItemsApp(null);
    const readOnlyApp = createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-reader",
      },
      permissions: ["inventory:read"],
    });
    const writeApp = createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-2",
        kind: "api-key",
        name: "inventory-writer",
      },
      permissions: ["inventory:write"],
    });

    const anonymousResponse = await anonymousApp.request(
      "/api/v1/inventory-items/item-1",
      {
        body: JSON.stringify({ title: "Travel pouch" }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "update-item-1",
        },
        method: "PUT",
      },
    );
    const forbiddenResponse = await readOnlyApp.request(
      "/api/v1/inventory-items/item-1",
      {
        body: JSON.stringify({ title: "Travel pouch" }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "update-item-1",
          "x-api-key": "qs_test_reader",
        },
        method: "PUT",
      },
    );
    const okResponse = await writeApp.request(
      "/api/v1/inventory-items/item-1",
      {
        body: JSON.stringify({
          aliases: ["passport pouch", "travel pouch"],
          category: "documents",
          costCents: 1995,
          costCurrency: "CAD",
          note: "Keep together",
          tags: ["travel", "documents"],
          title: "Travel pouch",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "update-item-1",
          "x-api-key": "qs_test_writer",
        },
        method: "PUT",
      },
    );
    const partialResponse = await writeApp.request(
      "/api/v1/inventory-items/item-1",
      {
        body: JSON.stringify({ title: "Passport pouch" }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "update-item-2",
          "x-api-key": "qs_test_writer",
        },
        method: "PUT",
      },
    );

    expect(anonymousResponse.status).toBe(401);
    expect(await anonymousResponse.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.json()).toEqual({
      code: "FORBIDDEN",
      message: "Missing required permission.",
    });
    expect(okResponse.status).toBe(200);
    expect(await okResponse.json()).toEqual({
      item: buildInventoryItem({
        id: "item-1",
        placements: [{ label: "Travel drawer (BIN-0003)", quantity: 2 }],
        title: "Travel pouch",
        totalQuantity: 2,
      }),
    });
    expect(partialResponse.status).toBe(200);
    expect(updateCalls).toEqual([
      {
        clientId: "api-key-2",
        idempotencyKey: "update-item-1",
        operation: "updateInventoryItem",
        itemId: "item-1",
        request: {
          acquisitionSource: undefined,
          aliases: ["passport pouch", "travel pouch"],
          captureText: undefined,
          category: "documents",
          costCents: 1995,
          costCurrency: "CAD",
          importance: undefined,
          kind: undefined,
          note: "Keep together",
          status: undefined,
          tags: ["documents", "travel"],
          title: "Travel pouch",
        },
      },
      {
        clientId: "api-key-2",
        idempotencyKey: "update-item-2",
        operation: "updateInventoryItem",
        itemId: "item-1",
        request: {
          acquisitionSource: undefined,
          aliases: undefined,
          captureText: undefined,
          category: undefined,
          costCents: undefined,
          costCurrency: undefined,
          importance: undefined,
          kind: undefined,
          note: undefined,
          status: undefined,
          tags: undefined,
          title: "Passport pouch",
        },
      },
    ]);
  });

  it("maps missing Item fact updates to the documented error envelope", async () => {
    const app = createQuietApp({
      inventoryItems: {
        updateItem: async () => {
          throw new Error("Inventory item was not found.");
        },
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "user-1",
          name: "QuantSelf Owner",
        },
        client: {
          id: "api-key-2",
          kind: "api-key",
          name: "inventory-writer",
        },
        permissions: ["inventory:write"],
      }),
    });

    const response = await app.request("/api/v1/inventory-items/missing", {
      body: JSON.stringify({ title: "Travel pouch" }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": "update-missing-item",
        "x-api-key": "qs_test_writer",
      },
      method: "PUT",
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "INVENTORY_ITEM_NOT_FOUND",
      message: "Inventory Item was not found.",
    });
  });

  it("requires Inventory Write before adding units through an idempotent API command", async () => {
    const addUnitsCalls: Array<{
      clientId: string;
      idempotencyKey: string;
      operation: string;
      itemId: string;
      request: Record<string, unknown>;
    }> = [];
    const createInventoryItemsApp = (accessContext: AccessContext | null) =>
      createQuietApp({
        inventoryItems: {
          addUnits: async (input) => {
            addUnitsCalls.push({
              clientId: input.clientId,
              idempotencyKey: input.idempotencyKey,
              operation: input.operation,
              itemId: input.itemId,
              request: input.request,
            });

            return {
              item: buildInventoryItem({
                id: input.itemId,
                placements: [
                  { label: "Travel drawer (BIN-0003)", quantity: 4 },
                ],
                title: "Travel pouch",
                totalQuantity: 4,
              }),
            };
          },
        },
        resolveAccessContext: async () => accessContext,
      });
    const anonymousApp = createInventoryItemsApp(null);
    const readOnlyApp = createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-reader",
      },
      permissions: ["inventory:read"],
    });
    const writeApp = createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-2",
        kind: "api-key",
        name: "inventory-writer",
      },
      permissions: ["inventory:write"],
    });

    const anonymousResponse = await anonymousApp.request(
      "/api/v1/inventory-items/item-1/add-units",
      {
        body: JSON.stringify({ containerId: "container-1", quantity: 2 }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "add-units-1",
        },
        method: "POST",
      },
    );
    const forbiddenResponse = await readOnlyApp.request(
      "/api/v1/inventory-items/item-1/add-units",
      {
        body: JSON.stringify({ containerId: "container-1", quantity: 2 }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "add-units-1",
          "x-api-key": "qs_test_reader",
        },
        method: "POST",
      },
    );
    const okResponse = await writeApp.request(
      "/api/v1/inventory-items/item-1/add-units",
      {
        body: JSON.stringify({ containerId: "container-1", quantity: 2 }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "add-units-1",
          "x-api-key": "qs_test_writer",
        },
        method: "POST",
      },
    );
    const missingBodyResponse = await writeApp.request(
      "/api/v1/inventory-items/item-1/add-units",
      {
        headers: {
          "idempotency-key": "add-units-missing-body",
          "x-api-key": "qs_test_writer",
        },
        method: "POST",
      },
    );

    expect(anonymousResponse.status).toBe(401);
    expect(await anonymousResponse.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.json()).toEqual({
      code: "FORBIDDEN",
      message: "Missing required permission.",
    });
    expect(okResponse.status).toBe(200);
    expect(await okResponse.json()).toEqual({
      item: buildInventoryItem({
        id: "item-1",
        placements: [{ label: "Travel drawer (BIN-0003)", quantity: 4 }],
        title: "Travel pouch",
        totalQuantity: 4,
      }),
    });
    expect(missingBodyResponse.status).toBe(400);
    expect(await missingBodyResponse.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "Request validation failed.",
    });
    expect(addUnitsCalls).toEqual([
      {
        clientId: "api-key-2",
        idempotencyKey: "add-units-1",
        operation: "addInventoryItemUnits",
        itemId: "item-1",
        request: {
          containerId: "container-1",
          locationId: null,
          note: null,
          quantity: 2,
        },
      },
    ]);
  });

  it("requires Inventory Write before moving and removing units through idempotent API commands", async () => {
    const moveUnitsCalls: Array<{
      clientId: string;
      idempotencyKey: string;
      operation: string;
      itemId: string;
      request: Record<string, unknown>;
    }> = [];
    const removeUnitsCalls: Array<{
      clientId: string;
      idempotencyKey: string;
      operation: string;
      itemId: string;
      request: Record<string, unknown>;
    }> = [];
    const createInventoryItemsApp = (accessContext: AccessContext | null) =>
      createQuietApp({
        inventoryItems: {
          moveUnits: async (input) => {
            moveUnitsCalls.push({
              clientId: input.clientId,
              idempotencyKey: input.idempotencyKey,
              operation: input.operation,
              itemId: input.itemId,
              request: input.request,
            });

            return {
              item: buildInventoryItem({
                id: input.itemId,
                placements: [
                  { label: "Travel drawer (BIN-0003)", quantity: 2 },
                ],
                title: "Travel pouch",
                totalQuantity: 2,
              }),
            };
          },
          removeUnits: async (input) => {
            removeUnitsCalls.push({
              clientId: input.clientId,
              idempotencyKey: input.idempotencyKey,
              operation: input.operation,
              itemId: input.itemId,
              request: input.request,
            });

            return {
              item: buildInventoryItem({
                archivedAt: "2026-07-29T12:00:00.000Z",
                id: input.itemId,
                placements: [],
                title: "Travel pouch",
                totalQuantity: 0,
              }),
            };
          },
        },
        resolveAccessContext: async () => accessContext,
      });
    const anonymousApp = createInventoryItemsApp(null);
    const readOnlyApp = createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-reader",
      },
      permissions: ["inventory:read"],
    });
    const writeApp = createInventoryItemsApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-2",
        kind: "api-key",
        name: "inventory-writer",
      },
      permissions: ["inventory:write"],
    });

    const anonymousMove = await anonymousApp.request(
      "/api/v1/inventory-items/item-1/move-units",
      {
        body: JSON.stringify({
          destinationContainerId: "container-2",
          quantity: 1,
          sourceContainerId: "container-1",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "move-units-1",
        },
        method: "POST",
      },
    );
    const forbiddenRemove = await readOnlyApp.request(
      "/api/v1/inventory-items/item-1/remove-units",
      {
        body: JSON.stringify({ containerId: "container-2", quantity: 2 }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "remove-units-1",
          "x-api-key": "qs_test_reader",
        },
        method: "POST",
      },
    );
    const okMove = await writeApp.request(
      "/api/v1/inventory-items/item-1/move-units",
      {
        body: JSON.stringify({
          destinationContainerId: "container-2",
          quantity: 1,
          sourceContainerId: "container-1",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "move-units-1",
          "x-api-key": "qs_test_writer",
        },
        method: "POST",
      },
    );
    const okRemove = await writeApp.request(
      "/api/v1/inventory-items/item-1/remove-units",
      {
        body: JSON.stringify({ containerId: "container-2", quantity: 2 }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "remove-units-1",
          "x-api-key": "qs_test_writer",
        },
        method: "POST",
      },
    );

    expect(anonymousMove.status).toBe(401);
    expect(await anonymousMove.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
    expect(forbiddenRemove.status).toBe(403);
    expect(await forbiddenRemove.json()).toEqual({
      code: "FORBIDDEN",
      message: "Missing required permission.",
    });
    expect(okMove.status).toBe(200);
    expect(await okMove.json()).toEqual({
      item: buildInventoryItem({
        id: "item-1",
        placements: [{ label: "Travel drawer (BIN-0003)", quantity: 2 }],
        title: "Travel pouch",
        totalQuantity: 2,
      }),
    });
    expect(okRemove.status).toBe(200);
    expect(await okRemove.json()).toEqual({
      item: buildInventoryItem({
        archivedAt: "2026-07-29T12:00:00.000Z",
        id: "item-1",
        placements: [],
        title: "Travel pouch",
        totalQuantity: 0,
      }),
    });
    expect(moveUnitsCalls).toEqual([
      {
        clientId: "api-key-2",
        idempotencyKey: "move-units-1",
        operation: "moveInventoryItemUnits",
        itemId: "item-1",
        request: {
          destinationContainerId: "container-2",
          destinationLocationId: null,
          quantity: 1,
          sourceContainerId: "container-1",
          sourceLocationId: null,
        },
      },
    ]);
    expect(removeUnitsCalls).toEqual([
      {
        clientId: "api-key-2",
        idempotencyKey: "remove-units-1",
        operation: "removeInventoryItemUnits",
        itemId: "item-1",
        request: {
          containerId: "container-2",
          locationId: null,
          quantity: 2,
        },
      },
    ]);
  });

  it("does not expose a Merge Items API route", async () => {
    const app = createQuietApp({
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "user-1",
          name: "QuantSelf Owner",
        },
        client: {
          id: "api-key-1",
          kind: "api-key",
          name: "inventory-writer",
        },
        permissions: ["inventory:write"],
      }),
    });
    const response = await app.request(
      "/api/v1/inventory-items/item-1/merge",
      {
        body: JSON.stringify({ duplicateItemId: "item-2" }),
        headers: {
          "content-type": "application/json",
          "x-api-key": "qs_test_writer",
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(404);
  });

  it("requires Inventory Read before listing Inventory Containers", async () => {
    const presetBounds: [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ] = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.8 },
      { x: 0.1, y: 0.8 },
    ];
    const hoverBounds: [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ] = [
      { x: 0.12, y: 0.12 },
      { x: 0.88, y: 0.12 },
      { x: 0.88, y: 0.78 },
      { x: 0.12, y: 0.78 },
    ];
    const containers = [
      {
        id: "container-1",
        itemCount: 2,
        latestCapturedAt: "2026-07-28T10:00:00.000Z",
        locationName: "Hall closet",
        name: "Travel tote",
        referenceId: "BIN-0001",
        sampleImages: [
          {
            alt: "Camera",
            caption: null,
            id: "image-camera",
          },
        ],
        sampleItems: [
          {
            audioId: null,
            hasAudio: false,
            id: "item-camera",
            imageHeight: null,
            imageId: "image-camera",
            imageIds: ["image-camera"],
            imageWidth: null,
            localQuantity: 2,
            textPreview: null,
            title: "Camera",
            totalQuantity: 2,
            videoId: null,
          },
        ],
        sizeLiters: 39,
        unitCount: 2,
        visualPreset: {
          backImageUrl: "/inventory/container-visual-catalog/39l/back.webp",
          bounds: presetBounds,
          emptyImageUrl: "/inventory/container-visual-catalog/39l/empty.webp",
          frontImageUrl: "/inventory/container-visual-catalog/39l/front.webp",
          height: 857,
          hoverBounds,
          id: "39L" as const,
          isDefault: false,
          name: "39L",
          shadowImageUrl: "/inventory/container-visual-catalog/39l/shadow.webp",
          width: 1456,
        },
        visualPresetKey: "39L",
      },
    ];
    let listCalls = 0;
    const createInventoryContainersApp = (
      accessContext: AccessContext | null,
    ) =>
      createQuietApp({
        inventoryContainers: {
          listContainers: async () => {
            listCalls += 1;
            return containers;
          },
        },
        resolveAccessContext: async () => accessContext,
      });
    const anonymousApp = createInventoryContainersApp(null);
    const writeOnlyApp = createInventoryContainersApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-bot",
      },
      permissions: ["inventory:write"],
    });
    const readApp = createInventoryContainersApp({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-2",
        kind: "api-key",
        name: "inventory-reader",
      },
      permissions: ["inventory:read"],
    });

    const anonymousResponse = await anonymousApp.request(
      "/api/v1/inventory-containers",
    );
    const forbiddenResponse = await writeOnlyApp.request(
      "/api/v1/inventory-containers",
      {
        headers: {
          "x-api-key": "qs_test_credential",
        },
      },
    );
    const okResponse = await readApp.request("/api/v1/inventory-containers", {
      headers: {
        "x-api-key": "qs_test_credential",
      },
    });

    expect(anonymousResponse.status).toBe(401);
    expect(await anonymousResponse.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.json()).toEqual({
      code: "FORBIDDEN",
      message: "Missing required permission.",
    });
    expect(okResponse.status).toBe(200);
    expect(await okResponse.json()).toEqual({ containers });
    expect(listCalls).toBe(1);
  });

  it("emits a structured API access log for a successful named API Key Client request", async () => {
    const logs: unknown[] = [];
    const authenticatedApp = createApp({
      emitAccessLog: (record) => {
        logs.push(record);
      },
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "user-1",
          name: "QuantSelf Owner",
        },
        client: {
          id: "api-key-1",
          kind: "api-key",
          name: "inventory-bot",
        },
        permissions: ["inventory:read", "inventory:write"],
      }),
    });

    const response = await authenticatedApp.request("/api/v1/access-context", {
      headers: {
        "x-api-key": "qs_test_credential",
      },
    });

    expect(response.status).toBe(200);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      accessContext: {
        ownerId: "user-1",
        clientId: "api-key-1",
        clientKind: "api-key",
        clientName: "inventory-bot",
      },
      auth: {
        mechanism: "api-key",
        outcome: "authenticated",
      },
      method: "GET",
      outcome: "completed",
      route: "/api/v1/access-context",
      status: 200,
    });
    expect(logs[0]).toEqual(
      expect.objectContaining({
        elapsedMs: expect.any(Number),
        timestamp: expect.any(String),
      }),
    );
  });

  it("emits rejected API access logs for anonymous, invalid API key, and forbidden requests", async () => {
    const rejectedLogs: unknown[] = [];
    const forbiddenLogs: unknown[] = [];
    const apiKeyAccessContext: AccessContext = {
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-bot",
      },
      permissions: ["inventory:write"],
    };
    const registerProtectedRoute = (
      protectedApp: ReturnType<typeof createApp>,
    ) => {
      protectedApp.get("/api/v1/test/delete", (context) => {
        const authorization = authorizeAccessContext(
          context.get("accessContext"),
          {
            action: "delete",
            domain: "inventory",
          },
        );
        if (!authorization.ok) {
          return jsonAuthorizationFailure(context, authorization.error);
        }

        return context.json({ ok: true }, 200);
      });
    };
    const anonymousApp = createApp({
      emitAccessLog: (record) => {
        rejectedLogs.push(record);
      },
      unsafeSkipContractValidationForTests: true,
      resolveAccessContext: async () => null,
    });
    const forbiddenApp = createApp({
      emitAccessLog: (record) => {
        forbiddenLogs.push(record);
      },
      registerRoutes: registerProtectedRoute,
      unsafeSkipContractValidationForTests: true,
      resolveAccessContext: async () => apiKeyAccessContext,
    });

    const anonymousResponse = await anonymousApp.request(
      "/api/v1/access-context",
    );
    const invalidApiKeyResponse = await anonymousApp.request(
      "/api/v1/access-context",
      {
        headers: {
          "x-api-key": "qs_invalid_credential",
        },
      },
    );
    const malformedApiKeyResponse = await anonymousApp.request(
      "/api/v1/access-context",
      {
        headers: {
          "x-api-key": "",
        },
      },
    );
    const forbiddenResponse = await forbiddenApp.request(
      "/api/v1/test/delete",
      {
        headers: {
          "x-api-key": "qs_test_credential",
        },
      },
    );

    expect(anonymousResponse.status).toBe(401);
    expect(invalidApiKeyResponse.status).toBe(401);
    expect(malformedApiKeyResponse.status).toBe(401);
    expect(forbiddenResponse.status).toBe(403);
    expect(rejectedLogs).toEqual([
      expect.objectContaining({
        accessContext: null,
        auth: {
          mechanism: "none",
          outcome: "anonymous",
        },
        method: "GET",
        outcome: "rejected",
        route: "/api/v1/access-context",
        status: 401,
      }),
      expect.objectContaining({
        accessContext: null,
        auth: {
          mechanism: "api-key",
          outcome: "invalid",
        },
        method: "GET",
        outcome: "rejected",
        route: "/api/v1/access-context",
        status: 401,
      }),
      expect.objectContaining({
        accessContext: null,
        auth: {
          mechanism: "api-key",
          outcome: "invalid",
        },
        method: "GET",
        outcome: "rejected",
        route: "/api/v1/access-context",
        status: 401,
      }),
    ]);
    expect(forbiddenLogs).toEqual([
      expect.objectContaining({
        accessContext: {
          ownerId: "user-1",
          clientId: "api-key-1",
          clientKind: "api-key",
          clientName: "inventory-bot",
        },
        auth: {
          mechanism: "api-key",
          outcome: "authenticated",
        },
        method: "GET",
        outcome: "rejected",
        route: "/api/v1/test/delete",
        status: 403,
      }),
    ]);
  });

  it("logs failed requests without credentials or request and response bodies", async () => {
    const requestSecret = "request-secret-value";
    const responseSecret = "response-secret-value";
    const presentedCredential = "qs_test_credential";
    const ingressSecret = "test-ingress-secret";
    const sessionSecret = "private-session-secret";
    const logs: unknown[] = [];
    const apiKeyAccessContext: AccessContext = {
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-bot",
      },
      permissions: ["inventory:write"],
    };
    const appWithSecrets = createApp({
      emitAccessLog: (record) => {
        logs.push(record);
      },
      registerRoutes: (protectedApp) => {
        protectedApp.post("/api/v1/test/echo-secret", async (context) => {
          const body = (await context.req.json()) as { secret: string };
          return context.json(
            {
              echoed: body.secret,
              responseSecret,
            },
            200,
          );
        });

        protectedApp.post("/api/v1/test/fail", async (context) => {
          await context.req.json();
          throw new Error("planned failure");
        });
      },
      unsafeSkipContractValidationForTests: true,
      resolveAccessContext: async () => apiKeyAccessContext,
    });

    const successResponse = await appWithSecrets.request(
      "/api/v1/test/echo-secret",
      {
        body: JSON.stringify({ secret: requestSecret }),
        headers: {
          "content-type": "application/json",
          "x-api-key": presentedCredential,
          "x-quantself-owner-proof": ingressSecret,
          cookie: `better-auth.session_token=${sessionSecret}`,
        },
        method: "POST",
      },
    );
    const failedResponse = await appWithSecrets.request("/api/v1/test/fail", {
      body: JSON.stringify({ secret: requestSecret }),
      headers: {
        "content-type": "application/json",
        "x-api-key": presentedCredential,
        "x-quantself-owner-proof": ingressSecret,
        cookie: `better-auth.session_token=${sessionSecret}`,
      },
      method: "POST",
    });

    expect(successResponse.status).toBe(200);
    expect(await successResponse.json()).toEqual({
      echoed: requestSecret,
      responseSecret,
    });
    expect(failedResponse.status).toBe(500);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toEqual(
      expect.objectContaining({
        accessContext: {
          ownerId: "user-1",
          clientId: "api-key-1",
          clientKind: "api-key",
          clientName: "inventory-bot",
        },
        auth: {
          mechanism: "api-key",
          outcome: "authenticated",
        },
        method: "POST",
        outcome: "failed",
        route: "/api/v1/test/fail",
        status: 500,
      }),
    );

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(presentedCredential);
    expect(serializedLogs).not.toContain(requestSecret);
    expect(serializedLogs).not.toContain(responseSecret);
    expect(serializedLogs).not.toContain(sessionSecret);
    expect(serializedLogs).not.toContain(ingressSecret);
  });

  it("does not let access-log delivery change API responses", async () => {
    const appWithBrokenLogger = createApp({
      emitAccessLog: async () => {
        throw new Error("logging unavailable");
      },
      resolveAccessContext: async () => null,
    });

    const response = await appWithBrokenLogger.request(
      "/api/v1/access-context",
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
  });

  it("preserves intentional HTTP errors while logging their matched route", async () => {
    const pathSecret = "private-item-id";
    const logs: unknown[] = [];
    const appWithHttpError = createApp({
      emitAccessLog: (record) => {
        logs.push(record);
      },
      registerRoutes: (protectedApp) => {
        protectedApp.get("/api/v1/test/items/:itemId", () => {
          throw new HTTPException(418, { message: "Not ready." });
        });
      },
      unsafeSkipContractValidationForTests: true,
      resolveAccessContext: async () => ({
        owner: {
          email: "owner@example.com",
          id: "user-1",
          name: "QuantSelf Owner",
        },
        client: {
          id: "quantself-web",
          kind: "web",
          name: "Quantself Web Client",
        },
        permissions: ["inventory:delete", "inventory:read", "inventory:write"],
      }),
    });

    const response = await appWithHttpError.request(
      `/api/v1/test/items/${pathSecret}`,
    );

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("Not ready.");
    expect(logs).toEqual([
      expect.objectContaining({
        outcome: "rejected",
        route: "/api/v1/test/items/:itemId",
        status: 418,
      }),
    ]);
    expect(JSON.stringify(logs)).not.toContain(pathSecret);
  });

  it("projects access-context through its public DTO", async () => {
    const accessContextWithInternalFields = {
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-bot",
        tokenHash: "private-hash",
      },
      permissions: ["inventory:read"],
      sessionToken: "private-session-token",
    } satisfies AccessContext & {
      client: AccessContext["client"] & { tokenHash: string };
      sessionToken: string;
    };
    const authenticatedApp = createQuietApp({
      resolveAccessContext: async () => accessContextWithInternalFields,
    });

    const response = await authenticatedApp.request("/api/v1/access-context");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-bot",
      },
      permissions: ["inventory:read"],
    });
  });

  it("serves Scalar from the installed package", async () => {
    const response = await app.request(
      "/api/reference-assets/scalar-1.63.0.js",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(
      1_000_000,
    );
  });

  it("resolves one Access Context per request and maps protected-route authz failures", async () => {
    const apiKeyAccessContext: AccessContext = {
      owner: {
        email: "owner@example.com",
        id: "user-1",
        name: "QuantSelf Owner",
      },
      client: {
        id: "api-key-1",
        kind: "api-key",
        name: "inventory-bot",
      },
      permissions: ["inventory:write"],
    };
    let anonymousCalls = 0;
    let apiKeyCalls = 0;
    let ownerCalls = 0;

    const registerProtectedRoute = (
      protectedApp: ReturnType<typeof createApp>,
    ) => {
      protectedApp.get("/api/v1/test/delete", (context) => {
        const authorization = authorizeAccessContext(
          context.get("accessContext"),
          {
            action: "delete",
            domain: "inventory",
          },
        );
        if (!authorization.ok) {
          return jsonAuthorizationFailure(context, authorization.error);
        }

        return context.json({ ok: true }, 200);
      });
    };

    const anonymousApp = createQuietApp({
      registerRoutes: registerProtectedRoute,
      unsafeSkipContractValidationForTests: true,
      resolveAccessContext: async () => {
        anonymousCalls += 1;
        return null;
      },
    });
    const apiKeyApp = createQuietApp({
      registerRoutes: registerProtectedRoute,
      unsafeSkipContractValidationForTests: true,
      resolveAccessContext: async () => {
        apiKeyCalls += 1;
        return apiKeyAccessContext;
      },
    });
    const ownerApp = createQuietApp({
      registerRoutes: registerProtectedRoute,
      unsafeSkipContractValidationForTests: true,
      resolveAccessContext: async () => {
        ownerCalls += 1;
        return {
          owner: {
            email: "owner@example.com",
            id: "user-1",
            name: "QuantSelf Owner",
          },
          client: {
            id: "quantself-web",
            kind: "web",
            name: "Quantself Web Client",
          },
          permissions: [
            "inventory:delete",
            "inventory:read",
            "inventory:write",
          ],
        };
      },
    });

    const anonymousResponse = await anonymousApp.request("/api/v1/test/delete");
    const apiKeyResponse = await apiKeyApp.request("/api/v1/test/delete", {
      headers: {
        "x-api-key": "qs_test_credential",
      },
    });
    const ownerResponse = await ownerApp.request("/api/v1/test/delete");

    expect(anonymousResponse.status).toBe(401);
    expect(await anonymousResponse.json()).toEqual({
      code: "UNAUTHENTICATED",
      message: "Authentication required.",
    });
    expect(apiKeyResponse.status).toBe(403);
    expect(await apiKeyResponse.json()).toEqual({
      code: "FORBIDDEN",
      message: "Missing required permission.",
    });
    expect(ownerResponse.status).toBe(200);
    expect(await ownerResponse.json()).toEqual({ ok: true });
    expect(anonymousCalls).toBe(1);
    expect(apiKeyCalls).toBe(1);
    expect(ownerCalls).toBe(1);
  });
});

describe("private Owner ingress contract", () => {
  it("maps proof to the singleton Owner and keeps Agent grants and provider credentials independent", async () => {
    const origin = "https://qs.girke.dev";
    const token = "a".repeat(64);
    const owner = { userId: "existing-owner", user: { id: "existing-owner", name: "Owner", email: "owner@example.test" } };
    const ownerProof = { "x-quantself-owner-proof": token };
    const agentKey = { "x-api-key": "test-agent-key" };
    const githubSecret = "synthetic GitHub webhook secret";
    const analyticsToken = "b".repeat(64);
    const variables = {
      QUANTSELF_OWNER_INGRESS_TOKEN: token,
      QUANTSELF_PUBLIC_ORIGIN: origin,
      QUANTSELF_GITHUB_WEBHOOK_SECRET: githubSecret,
      QUANTSELF_WEBSITE_ANALYTICS_INGEST_TOKEN: analyticsToken,
    };
    const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
    Object.assign(process.env, variables);
    try {
      let ownerLookups = 0;
      let jobsReads = 0;
      const jobsWorkers = {
        db: { jobCandidateContext: { findUnique: async ({ where }: { where: { ownerId: string } }) => {
          expect(where.ownerId).toBe(owner.userId);
          jobsReads++;
          return null;
        } } },
      } as unknown as NonNullable<Parameters<typeof createApp>[0]>["jobsWorkers"];
      const app = createApp({
        emitAccessLog: () => {},
        unsafeSkipContractValidationForTests: true,
        jobsWorkers,
        resolveAccessContext: headers => resolveAccessContext(headers, {
          findExistingOwner: async () => { ownerLookups++; return owner; },
          findOwnerByUserId: async userId => userId === owner.userId ? owner : null,
          verifyApiKey: async key => key === agentKey["x-api-key"] ? {
            id: "key-id", referenceId: owner.userId, name: "Test Agent grant",
            metadata: { quantselfAgentClient: { id: "jobs-agent", name: "Jobs Agent", avatar: null } },
            permissions: resolveApiKeyPermissions({ preset: "custom", permissionIds: ["jobs:read", "budgeting:read"] }),
          } : null,
        }),
      });
      const access = "/api/v1/access-context";
      const jobs = "/api/v1/jobs/candidate-context";
      const receipt = "/api/v1/budgeting/receipts/cc4e401d-74a1-4ec7-8b23-b1e97dbc0642/original";
      const request = (path: string, init?: RequestInit) => app.request(origin + path, init);
      const spoofed = {
        Cookie: "better-auth.session_token=retained-legacy-session",
        "Tailscale-User-Login": owner.user.email,
        "X-Forwarded-For": "100.64.0.1",
        "X-Forwarded-Host": "qs.girke.dev",
        "X-Forwarded-Proto": "https",
      };

      for (const headers of [{}, spoofed, { ...spoofed, "x-quantself-owner-proof": "c".repeat(64) }]) {
        for (const path of [access, jobs, receipt]) {
          const response = await request(path, { headers });
          expect(response.status).toBe(401);
          expect(response.headers.get("location")).toBeNull();
        }
      }
      expect(ownerLookups).toBe(0);

      const ownerResponse = await request(access, { headers: ownerProof });
      expect(ownerResponse.status).toBe(200);
      expect(ownerResponse.headers.get("cache-control")).toContain("no-store");
      expect(ownerResponse.headers.get("set-cookie")).toBeNull();
      expect(await ownerResponse.json()).toMatchObject({ owner: { id: owner.userId }, client: { kind: "web" } });

      const browserJob = await request(jobs, { headers: ownerProof });
      expect(browserJob.status).toBe(200);
      expect(await browserJob.json()).toEqual({ markdown: "", version: 0 });

      const agentResponse = await request(access, { headers: { ...ownerProof, ...agentKey } });
      expect(agentResponse.status).toBe(200);
      expect(await agentResponse.json()).toMatchObject({
        client: { id: "jobs-agent", kind: "agent" },
        permissions: ["budgeting:read", "jobs:read"],
      });
      expect((await request(jobs, { headers: agentKey })).status).toBe(200);
      expect(jobsReads).toBe(2);
      expect((await request(access, { headers: { ...ownerProof, "x-api-key": "bad-key" } })).status).toBe(401);
      const deniedReceipt = await request(receipt, { headers: { ...ownerProof, ...agentKey } });
      expect(deniedReceipt.status).toBe(403);
      expect(deniedReceipt.headers.get("location")).toBeNull();
      const receiptDetail = receipt.slice(0, -"/original".length);
      for (const path of [receiptDetail + "?reveal=yes", receipt]) {
        const response = await request(path, { headers: { ...agentKey, Range: "bytes=0-1" } });
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("location")).toBeNull();
        expect(response.headers.get("content-range")).toBeNull();
        expect(await response.json()).toEqual({ message: "Missing budget permission." });
      }

      const foreignOrigin = "https://untrusted.example";
      const write = (requestOrigin?: string) => request(jobs, {
        method: "PATCH",
        headers: { ...ownerProof, "Content-Type": "application/json", ...(requestOrigin ? { Origin: requestOrigin } : {}) },
        body: "{}",
      });
      expect((await write()).status).toBe(403);
      expect((await write(foreignOrigin)).status).toBe(403);
      expect((await write(origin)).status).toBe(400);
      const deniedAgentWrite = await request(jobs, {
        method: "PATCH",
        headers: { ...ownerProof, ...agentKey, Origin: origin, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(deniedAgentWrite.status).toBe(403);
      const preflight = await request(jobs, {
        method: "OPTIONS",
        headers: { Origin: foreignOrigin, "Access-Control-Request-Method": "PATCH" },
      });
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
      expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();

      const pingBody = "{}";
      const signedPing = `sha256=${createHmac("sha256", githubSecret).update(pingBody).digest("hex")}`;
      const ping = (signature?: string, proof: Record<string, string> = ownerProof) => request("/api/todo-webhooks/github", {
        method: "POST", body: pingBody,
        headers: {
          ...proof,
          "x-github-event": "ping",
          "x-github-delivery": "synthetic-ping",
          ...(signature ? { "x-hub-signature-256": signature } : {}),
        },
      });
      expect((await ping()).status).toBe(401);
      expect((await ping(`sha256=${"0".repeat(64)}`)).status).toBe(401);
      const acceptedPing = await ping(signedPing, {});
      expect(acceptedPing.status).toBe(200);
      expect(await acceptedPing.json()).toEqual({ accepted: true });

      const ingest = (headers: Record<string, string>) => request("/api/v1/website-analytics/events", {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}",
      });
      expect((await ingest(ownerProof)).status).toBe(401);
      expect((await ingest(agentKey)).status).toBe(401);
      expect((await ingest({ "x-api-key": analyticsToken })).status).toBe(400);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
