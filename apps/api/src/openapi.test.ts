import { createRoute, z } from "@hono/zod-openapi";
import { compileErrors, validate } from "@readme/openapi-parser";
import { describe, expect, it } from "bun:test";
import type { OpenAPIV3_1 } from "openapi-types";
import { createApp } from "./app";
import { assertPublicApiContractQuality, getOpenAPIDocument } from "./openapi";

const testResourceRoute = createRoute({
  method: "get",
  operationId: "getTestResourceById",
  path: "/api/v1/test-resources/{resourceId}",
  request: {
    params: z.object({
      resourceId: z.string().openapi({ example: "resource_123" }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          example: { id: "resource_123" },
          schema: z.object({ id: z.string() }),
        },
      },
      description: "Test resource found.",
    },
    404: {
      content: {
        "application/json": {
          example: {
            code: "NOT_FOUND",
            message: "Test resource not found.",
          },
          schema: z.object({
            code: z.literal("NOT_FOUND"),
            message: z.string(),
          }),
        },
      },
      description: "Test resource not found.",
    },
  },
  security: [{ apiKeyAuth: [] }],
  summary: "Get test resource",
  tags: ["Auth"],
  "x-destructive": false,
  "x-required-permissions": ["inventory:read"],
  description:
    "Returns a test resource by identifier. Authentication: X-API-Key. Required permissions: inventory:read. Inputs: resourceId path parameter. Success response: 200 with the test resource identifier. Failure responses: 404 when the test resource does not exist. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
});

function registerTestResourceRoute(app: ReturnType<typeof createApp>) {
  app.openapi(testResourceRoute, (context) =>
    context.json({ id: context.req.valid("param").resourceId }, 200),
  );
}

function accessContextContractFixture() {
  const app = createApp({
    emitAccessLog: () => {},
    resolveAccessContext: async () => null,
  });
  const document = getOpenAPIDocument(app, { validate: false });
  const operation = document.paths?.["/api/v1/access-context"]?.get;
  const response = operation?.responses?.["200"];

  if (!operation || !response || "$ref" in response) {
    throw new Error("Expected inline access-context operation and response");
  }

  const mediaType = response.content?.["application/json"];
  if (!mediaType) {
    throw new Error("Expected access-context JSON response");
  }

  return { app, document, mediaType, operation };
}

describe("public OpenAPI quality gate", () => {
  it("documents complete category-aware inventory write workflows", () => {
    const app = createApp({
      emitAccessLog: () => {},
      resolveAccessContext: async () => null,
    });
    const document = getOpenAPIDocument(app);
    const schemas = document.components?.schemas as Record<
      string,
      {
        description?: string;
        properties?: Record<
          string,
          {
            description?: string;
            items?: { maxLength?: number };
            minItems?: number;
          }
        >;
        required?: string[];
      }
    >;
    const guide = document.info.description ?? "";
    const captureRequest = schemas.CaptureInventoryItemRequest;
    const captureCategory =
      captureRequest?.properties?.category;
    const clothingAttributes = schemas.InventoryClothingProfileAttributes;
    const clothingUpdate = schemas.UpdateInventoryClothingProfileRequest;
    const remedyRegistration = schemas.RegisterInventoryRemedyRequest;
    const remedyUpdate = schemas.UpdateInventoryRemedyProfileRequest;
    const remedyIntake = schemas.CreateRemedyIntakeRequest;
    const serializedContract = JSON.stringify(document);

    expect(serializedContract).not.toContain("/api/v1/inventory-products");
    expect(serializedContract).not.toContain("/move-products");
    expect(serializedContract).not.toContain("InventoryProduct");
    expect(serializedContract).not.toContain('"productId"');

    expect(guide).toContain("Inventory write quick reference");
    expect(guide).toContain("category: `food`");
    expect(guide).toContain("category: `supplement`");
    expect(guide).toContain("category: `clothing`");
    expect(guide).toContain("Food and supplements have no specialist Profile");
    expect(guide).toContain("GET, merge, then PUT the complete Clothing Profile");
    expect(guide).toContain("Do not create remedies through generic Item capture");
    expect(guide).toContain("search for an existing `homeopathy` Item");
    expect(guide).toContain("one Inventory Item per remedy");
    expect(guide).toContain("uppercase, deduplicated, and sorted");
    expect(guide).toContain("no per-potency quantities");
    expect(guide).toContain("does not decrement Inventory quantity");

    expect(captureCategory?.description).toContain(
      "food, supplement, and clothing",
    );
    expect(captureCategory?.description).toContain("/api/v1/inventory-remedies");
    expect(Object.keys(captureRequest?.properties ?? {}).sort()).toEqual(
      [
        "acquisitionSource",
        "captureSessionId",
        "captureText",
        "category",
        "containerId",
        "containerLabelOverride",
        "costCents",
        "costCurrency",
        "importance",
        "kind",
        "locationId",
        "note",
        "quantity",
        "status",
        "title",
      ].sort(),
    );
    expect(clothingUpdate?.required?.sort()).toEqual([
      "attributes",
      "isDirty",
    ]);
    expect(clothingUpdate?.description).toContain("Complete replacement");
    expect(clothingAttributes?.description).toContain("GET and merge");
    expect(Object.keys(clothingAttributes?.properties ?? {}).sort()).toEqual(
      [
        "colors",
        "decisionNotes",
        "fitNotes",
        "formality",
        "kind",
        "layer",
        "material",
        "occasionTags",
        "version",
        "warmth",
        "weather",
      ].sort(),
    );
    expect(remedyRegistration?.properties?.potencies).toMatchObject({
      minItems: 1,
      items: { maxLength: 32 },
    });
    expect(remedyRegistration?.properties?.potencies?.description).toContain(
      "All owned potencies",
    );
    expect(remedyRegistration?.properties?.quantity?.description).toContain(
      "not per potency",
    );
    expect(Object.keys(remedyRegistration?.properties ?? {}).sort()).toEqual(
      [
        "aliases",
        "containerId",
        "externalReferences",
        "locationId",
        "note",
        "placementNote",
        "potencies",
        "quantity",
        "selectionSummary",
        "title",
      ].sort(),
    );
    expect(remedyUpdate?.properties?.potencies).toMatchObject({
      minItems: 1,
      items: { maxLength: 32 },
    });
    expect(remedyUpdate?.properties?.potencies?.description).toContain(
      "replaces the complete owned set",
    );
    expect(remedyIntake?.properties?.potency?.description).toContain(
      "must match one owned potency",
    );
  });

  it("accepts contract-first parameter routes after Hono path normalization", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      registerRoutes: registerTestResourceRoute,
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

    const response = await app.request("/api/v1/test-resources/resource_123");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "resource_123" });
  });

  it("rejects duplicate OpenAPI route registrations", () => {
    expect(() =>
      createApp({
        emitAccessLog: () => {},
        registerRoutes: (app) => {
          registerTestResourceRoute(app);
          registerTestResourceRoute(app);
        },
        resolveAccessContext: async () => null,
      }),
    ).toThrow(/duplicate public openapi route registration/i);
  });

  it("rejects exact-prefix and wildcard routes without contracts", () => {
    for (const path of ["/api/v1", "/api/v1/items/*"]) {
      expect(() =>
        createApp({
          emitAccessLog: () => {},
          registerRoutes: (app) => {
            app.get(path, (context) => context.json({ ok: true }, 200));
          },
          resolveAccessContext: async () => null,
        }),
      ).toThrow(/undocumented public api route/i);
    }
  });

  it("rejects secret-like values nested in named examples", () => {
    const { app, document, mediaType } = accessContextContractFixture();

    delete mediaType.example;
    mediaType.examples = {
      leaked: {
        value: {
          token: "qs_live_not-a-placeholder",
        },
      },
    };

    expect(() => assertPublicApiContractQuality(app, document)).toThrow(
      /secret-like data/i,
    );
  });

  it("rejects incomplete operation and JSON response metadata", () => {
    const missingSummary = accessContextContractFixture();
    delete missingSummary.operation.summary;

    expect(() =>
      assertPublicApiContractQuality(
        missingSummary.app,
        missingSummary.document,
      ),
    ).toThrow(/missing summary/i);

    const missingExample = accessContextContractFixture();
    delete missingExample.mediaType.example;

    expect(() =>
      assertPublicApiContractQuality(
        missingExample.app,
        missingExample.document,
      ),
    ).toThrow(/missing a json example/i);

    const legacyPermissionMetadata = accessContextContractFixture();
    const legacyOperation =
      legacyPermissionMetadata.operation as typeof legacyPermissionMetadata.operation & {
        "x-required-scopes"?: string[];
      };
    legacyOperation["x-required-scopes"] = [];

    expect(() =>
      assertPublicApiContractQuality(
        legacyPermissionMetadata.app,
        legacyPermissionMetadata.document,
      ),
    ).toThrow(/legacy scope metadata/i);
  });

  it("rejects external references and documented routes without handlers", () => {
    const externalReference = accessContextContractFixture();
    externalReference.mediaType.schema = {
      $ref: "https://example.com/schemas/access-context.json",
    };

    expect(() =>
      assertPublicApiContractQuality(
        externalReference.app,
        externalReference.document,
      ),
    ).toThrow(/external schema reference/i);

    const unmountedRoute = accessContextContractFixture();
    unmountedRoute.document.paths ??= {};
    unmountedRoute.document.paths["/api/v1/unmounted"] = {
      get: {
        ...structuredClone(unmountedRoute.operation),
        operationId: "getUnmounted",
      },
    };

    expect(() =>
      assertPublicApiContractQuality(
        unmountedRoute.app,
        unmountedRoute.document,
      ),
    ).toThrow(/unmounted public api route/i);
  });

  it("accepts self-contained response component references", () => {
    expect(() =>
      createApp({
        emitAccessLog: () => {},
        registerRoutes: (app) => {
          const successResponse = app.openAPIRegistry.registerComponent(
            "responses",
            "ContractTestSuccess",
            {
              content: {
                "application/json": {
                  example: { ok: true },
                  schema: {
                    properties: { ok: { type: "boolean" } },
                    required: ["ok"],
                    type: "object",
                  },
                },
              },
              description: "Successful response.",
            },
          );
          const failureResponse = app.openAPIRegistry.registerComponent(
            "responses",
            "ContractTestFailure",
            {
              content: {
                "application/json": {
                  example: {
                    code: "NOT_FOUND",
                    message: "Record not found.",
                  },
                  schema: {
                    properties: {
                      code: { type: "string" },
                      message: { type: "string" },
                    },
                    required: ["code", "message"],
                    type: "object",
                  },
                },
              },
              description: "Record not found.",
            },
          );
          const referencedRoute = createRoute({
            method: "get",
            operationId: "getReferencedResponse",
            path: "/api/v1/reference-test",
            responses: {
              200: successResponse.ref,
              404: failureResponse.ref,
            },
            security: [{ apiKeyAuth: [] }],
            summary: "Test response references",
            tags: ["Auth"],
            "x-destructive": false,
            "x-required-permissions": [],
            description:
              "Exercises internal response references. Authentication: X-API-Key. Required permissions: none. Inputs: none. Success response: 200 with a boolean result. Failure responses: 404 when the record does not exist. Side effects: none. Destructive: no. Retry safety: safe to repeat and idempotent.",
          });

          app.openapi(referencedRoute, () =>
            Response.json({ ok: true }, { status: 200 }),
          );
        },
        resolveAccessContext: async () => null,
      }),
    ).not.toThrow();
  });

  it("produces a standards-valid OpenAPI 3.1 document", async () => {
    const app = createApp({
      emitAccessLog: () => {},
      resolveAccessContext: async () => null,
    });
    const response = await app.request("/api/openapi.json");
    const document = (await response.json()) as OpenAPIV3_1.Document;
    const result = await validate(document);

    expect(result.valid ?? false, compileErrors(result)).toBe(true);
  });
});
