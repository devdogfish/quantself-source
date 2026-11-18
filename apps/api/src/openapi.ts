import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "hono";

export const OPENAPI_PATH = "/api/openapi.json";
export const REFERENCE_PATH = "/api/reference";
export const MARKDOWN_REFERENCE_PATH = "/api/reference.md";
const PRIVATE_RECEIPT_PATH = "/api/v1/budgeting/receipts";

const PUBLIC_API_PREFIX = "/api/v1/";
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
const REQUIRED_DESCRIPTION_SNIPPETS = [
  "Authentication:",
  "Required permissions:",
  "Inputs:",
  "Success response:",
  "Failure responses:",
  "Side effects:",
  "Destructive:",
  "Retry safety:",
] as const;
const SECRET_LIKE_EXAMPLE_PATTERN =
  /\b(?:AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_]+|qs_(?:live|prod|test)?_[A-Za-z0-9_]+|sk_[A-Za-z0-9_]+)\b|-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/;

const inventoryWriteQuickReference = `## Inventory write quick reference

Before writing, inspect the operation request schema and field descriptions. Send every known source fact, omit unknown optional fields, and never invent values.

### Food and supplements

Use \`POST /api/v1/inventory-items/capture\` with category: \`food\` or category: \`supplement\`. Food and supplements have no specialist Profile. Send a title and/or captureText, quantity, at most one Placement target (containerId or locationId), and any known capture fields: acquisitionSource, captureSessionId, containerLabelOverride, costCents, costCurrency, importance, kind, note, and status. Quantity defaults to 1. Update later shared facts such as title, aliases, tags, note, and category through the generic Item PUT. Change quantity or Placement through the add, move, and remove units operations, not the generic Item update.

### Clothing

Use \`POST /api/v1/inventory-items/capture\` with category: \`clothing\`; capture creates a default Clothing Profile. Then GET, merge, then PUT the complete Clothing Profile at \`/api/v1/inventory-items/{itemId}/clothing-profile\`. The PUT body requires isDirty and attributes. Attributes require version: 1 and may contain kind, colors, layer, warmth, formality, weather, occasionTags, material, fitNotes, and decisionNotes. PUT replaces the entire Profile, so preserve existing fields and send every known attribute.

### Remedies and potencies

Do not create remedies through generic Item capture or by changing a generic Item to category: \`homeopathy\`. First search for an existing \`homeopathy\` Item with \`GET /api/v1/inventory-items?category=homeopathy&q={remedy}\`. Quantself keeps one Inventory Item per remedy. If it exists, GET its Remedy Profile, union the new potency with the existing potencies, then PUT the complete set to \`/api/v1/inventory-items/{itemId}/remedy-profile\`. If absent, use \`POST /api/v1/inventory-remedies\` with required title and potencies plus any known aliases, quantity, note, placementNote, containerId or locationId, selectionSummary, and externalReferences. Potencies are trimmed, uppercase, deduplicated, and sorted. Item quantity is aggregate stock; Quantself tracks no per-potency quantities. A Remedy Intake must select one owned potency and does not decrement Inventory quantity.`;

export const openAPIConfig = {
  openapi: "3.1.1" as const,
  info: {
    title: "QuantSelf API",
    version: "0.1.0",
    description: [
      "Authenticated API foundation for the self-hosted QuantSelf personal operating system.",
      "Agent Clients authenticate with a dedicated API Key and explicit Permissions. The supported Agent mutation is PATCH /api/v1/jobs/applications/{id} for eligible drafts. Send the expectedRevision from your read. A successful Agent edit returns an auditId. The Owner can list Agent writes or Undo one while its revision is current. GitHub-backed To-Dos support Agent reads with the appropriate Permission.",
      inventoryWriteQuickReference,
    ].join("\n\n"),
  },
  components: {
    securitySchemes: {
      apiKeyAuth: {
        description: "Use a named QuantSelf API key in the X-API-Key header.",
        in: "header" as const,
        name: "X-API-Key",
        type: "apiKey" as const,
      },
      websiteAnalyticsIngest: {
        description: "Dedicated portfolio key for website event and inquiry ingestion.",
        in: "header" as const,
        name: "X-API-Key",
        type: "apiKey" as const,
      },
      ownerSession: {
        description:
          "Trusted ingress proof for the same-origin Owner Web Client. The private ingress sets this header.",
        in: "header" as const,
        name: "X-Quantself-Owner-Proof",
        type: "apiKey" as const,
      },
    },
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "Tracked links", description: "Portfolio redirects for applications and posts." },
    { name: "Jobs", description: "Application review, records, and approved work." },
    { name: "Website analytics", description: "Owner reports for Website traffic and Job search activity." },
    { name: "Habits", description: "Daily habit definitions and observations." },
    { name: "Meetings", description: "Visitor booking through the portfolio's booking-only key." },
    { name: "Budgeting", description: "Cash runway, spending, and receipts." },
    { name: "To-Dos", description: "Live GitHub-backed To-Do reads." },
    { name: "Website Analytics", description: "Portfolio event and inquiry ingestion and Owner inquiry status." },
    {
      description:
        "Authentication and Access Context endpoints for the Owner and Clients.",
      name: "Auth",
    },
    {
      description:
        "Inventory Item, placement, and related inventory application endpoints.",
      name: "Inventory",
    },
  ],
};

type OpenAPIDocument = ReturnType<OpenAPIHono<Env>["getOpenAPI31Document"]>;

type OpenAPIOperation = NonNullable<
  NonNullable<OpenAPIDocument["paths"]>[string]
>[(typeof HTTP_METHODS)[number]];

function assertContract(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPublicApiPath(path: string) {
  return path === "/api/v1" || path.startsWith(PUBLIC_API_PREFIX);
}

function toOpenAPIPath(path: string) {
  return path.replace(/\/:([A-Za-z0-9_]+)/g, "/{$1}");
}

function routeKey(method: string, path: string) {
  return `${method.toLowerCase()} ${path}`;
}

function collectMountedPublicRoutes<TEnv extends Env>(app: OpenAPIHono<TEnv>) {
  return [
    ...new Set(
      app.routes
        .filter(
          (route) =>
            isPublicApiPath(route.path) &&
            !(route.method === "ALL" && route.path === "/api/v1/*"),
        )
        .map((route) => routeKey(route.method, toOpenAPIPath(route.path))),
    ),
  ];
}

function collectRegisteredPublicRoutes<TEnv extends Env>(
  app: OpenAPIHono<TEnv>,
) {
  return app.openAPIRegistry.definitions.flatMap((definition) =>
    definition.type === "route" && isPublicApiPath(definition.route.path)
      ? [routeKey(definition.route.method, definition.route.path)]
      : [],
  );
}

function collectDocumentedPublicRoutes(document: OpenAPIDocument) {
  const documentedRoutes: string[] = [];

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (!isPublicApiPath(path)) {
      continue;
    }

    for (const method of HTTP_METHODS) {
      if (pathItem?.[method]) {
        documentedRoutes.push(routeKey(method, path));
      }
    }
  }

  return documentedRoutes;
}

function walkDocument(
  value: unknown,
  visit: (value: unknown, path: string[]) => void,
  path: string[] = [],
) {
  visit(value, path);

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walkDocument(item, visit, [...path, String(index)]);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      walkDocument(entry, visit, [...path, key]);
    }
  }
}

function assertNoExternalRefs(document: OpenAPIDocument) {
  walkDocument(document, (value, path) => {
    if (path.at(-1) !== "$ref" || typeof value !== "string") {
      return;
    }

    assertContract(
      value.startsWith("#/"),
      `OpenAPI document contains external schema reference: ${value}`,
    );
  });
}

function assertSafeExamples(document: OpenAPIDocument) {
  walkDocument(document, (value, path) => {
    if (
      typeof value !== "string" ||
      !path.some((segment) => segment === "example" || segment === "examples")
    ) {
      return;
    }

    assertContract(
      !SECRET_LIKE_EXAMPLE_PATTERN.test(value),
      `OpenAPI example contains secret-like data at ${path.join(".")}`,
    );
  });
}

function resolveInternalReference(
  document: OpenAPIDocument,
  value: unknown,
  context: string,
  seenReferences = new Set<string>(),
): unknown {
  if (!isRecord(value) || typeof value.$ref !== "string") {
    return value;
  }

  const reference = value.$ref;
  assertContract(
    reference.startsWith("#/"),
    `OpenAPI ${context} uses external reference: ${reference}`,
  );
  assertContract(
    !seenReferences.has(reference),
    `OpenAPI ${context} contains circular reference: ${reference}`,
  );

  let resolved: unknown = document;
  for (const encodedSegment of reference.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    assertContract(
      isRecord(resolved) && segment in resolved,
      `OpenAPI ${context} contains unresolved reference: ${reference}`,
    );
    resolved = resolved[segment];
  }

  seenReferences.add(reference);
  return resolveInternalReference(document, resolved, context, seenReferences);
}

function assertJsonContentQuality(
  routeKey: string,
  context: string,
  content: unknown,
) {
  if (!isRecord(content)) {
    return;
  }

  for (const [contentType, mediaType] of Object.entries(content)) {
    if (!contentType.startsWith("application/json")) {
      continue;
    }

    assertContract(
      isRecord(mediaType),
      `OpenAPI operation ${routeKey} ${context} has invalid JSON content`,
    );
    assertContract(
      "schema" in mediaType,
      `OpenAPI operation ${routeKey} ${context} is missing a JSON schema`,
    );
    assertContract(
      "example" in mediaType || "examples" in mediaType,
      `OpenAPI operation ${routeKey} ${context} is missing a JSON example`,
    );
  }
}

function assertOperationQuality(
  routeKey: string,
  operation: OpenAPIOperation,
  operationIds: Set<string>,
  document: OpenAPIDocument,
  declaredTags: Set<string>,
) {
  assertContract(operation, `Missing OpenAPI operation for ${routeKey}`);
  assertContract(
    typeof operation.operationId === "string" &&
      operation.operationId.trim().length > 0,
    `OpenAPI operation ${routeKey} is missing operationId`,
  );
  assertContract(
    !operationIds.has(operation.operationId),
    `OpenAPI operationId ${operation.operationId} is duplicated`,
  );
  operationIds.add(operation.operationId);

  assertContract(
    Array.isArray(operation.tags) &&
      operation.tags.length > 0 &&
      operation.tags.every(
        (tag) =>
          typeof tag === "string" &&
          tag.trim().length > 0 &&
          declaredTags.has(tag),
      ),
    `OpenAPI operation ${routeKey} is missing tags`,
  );
  assertContract(
    typeof operation.summary === "string" &&
      operation.summary.trim().length > 0,
    `OpenAPI operation ${routeKey} is missing summary`,
  );
  const description = operation.description;
  assertContract(
    typeof description === "string" && description.trim().length > 0,
    `OpenAPI operation ${routeKey} is missing description`,
  );

  for (const snippet of REQUIRED_DESCRIPTION_SNIPPETS) {
    assertContract(
      description.includes(snippet),
      `OpenAPI operation ${routeKey} description is missing ${snippet}`,
    );
  }

  assertContract(
    Array.isArray(operation["x-required-permissions"]) &&
      operation["x-required-permissions"].every(
        (permission) =>
          typeof permission === "string" && permission.trim().length > 0,
      ) &&
      new Set(operation["x-required-permissions"]).size ===
        operation["x-required-permissions"].length,
    `OpenAPI operation ${routeKey} is missing x-required-permissions`,
  );
  assertContract(
    typeof operation["x-destructive"] === "boolean",
    `OpenAPI operation ${routeKey} is missing x-destructive`,
  );
  assertContract(
    operation["x-quantself-required-permissions"] === undefined,
    `OpenAPI operation ${routeKey} still uses x-quantself-required-permissions`,
  );
  const legacyOperation = operation as typeof operation & {
    "x-quantself-required-scopes"?: unknown;
    "x-required-scopes"?: unknown;
  };
  assertContract(
    legacyOperation["x-required-scopes"] === undefined &&
      legacyOperation["x-quantself-required-scopes"] === undefined,
    `OpenAPI operation ${routeKey} still uses legacy scope metadata`,
  );
  assertContract(
    operation["x-quantself-destructive"] === undefined,
    `OpenAPI operation ${routeKey} still uses x-quantself-destructive`,
  );
  assertContract(
    Array.isArray(operation.security),
    `OpenAPI operation ${routeKey} is missing security metadata`,
  );

  const requiredPermissions = operation["x-required-permissions"];
  assertContract(
    requiredPermissions.length > 0
      ? requiredPermissions.every((permission) =>
          description.includes(permission),
        )
      : description.includes("Required permissions: none."),
    `OpenAPI operation ${routeKey} description disagrees with x-required-permissions`,
  );
  assertContract(
    description.includes(
      operation["x-destructive"] ? "Destructive: yes." : "Destructive: no.",
    ),
    `OpenAPI operation ${routeKey} description disagrees with x-destructive`,
  );

  const securitySchemes = document.components?.securitySchemes ?? {};
  for (const securityRequirement of operation.security) {
    assertContract(
      isRecord(securityRequirement) &&
        Object.keys(securityRequirement).length > 0,
      `OpenAPI operation ${routeKey} has invalid security metadata`,
    );

    for (const [scheme, permissions] of Object.entries(securityRequirement)) {
      assertContract(
        scheme in securitySchemes &&
          Array.isArray(permissions) &&
          permissions.every((permission) => typeof permission === "string"),
        `OpenAPI operation ${routeKey} has invalid security metadata`,
      );
    }
  }

  if (operation.security.length === 0) {
    assertContract(
      description.includes("Authentication: none."),
      `OpenAPI public operation ${routeKey} must state Authentication: none.`,
    );
  }

  const responses = Object.entries(operation.responses ?? {});
  assertContract(
    responses.length > 0,
    `OpenAPI operation ${routeKey} is missing responses`,
  );
  assertContract(
    responses.some(([statusCode]) => /^(?:2\d{2}|2XX)$/.test(statusCode)),
    `OpenAPI operation ${routeKey} is missing a success response`,
  );
  assertContract(
    responses.some(([statusCode]) => /^(?:4\d{2}|4XX)$/.test(statusCode)),
    `OpenAPI operation ${routeKey} is missing an expected failure response`,
  );

  for (const [statusCode, response] of responses) {
    const resolvedResponse = resolveInternalReference(
      document,
      response,
      `${routeKey} response ${statusCode}`,
    );
    assertContract(
      isRecord(resolvedResponse) &&
        typeof resolvedResponse.description === "string" &&
        resolvedResponse.description.trim().length > 0,
      `OpenAPI operation ${routeKey} response ${statusCode} is missing description`,
    );
    assertJsonContentQuality(
      routeKey,
      `response ${statusCode}`,
      resolvedResponse.content,
    );
  }

  if (operation.requestBody) {
    const requestBody = resolveInternalReference(
      document,
      operation.requestBody,
      `${routeKey} request body`,
    );
    assertContract(
      isRecord(requestBody),
      `OpenAPI operation ${routeKey} has invalid request body`,
    );
    assertJsonContentQuality(routeKey, "request body", requestBody.content);
  }
}

export function assertPublicApiContractQuality<TEnv extends Env>(
  app: OpenAPIHono<TEnv>,
  document: OpenAPIDocument,
) {
  const mountedRoutes = collectMountedPublicRoutes(app).sort();
  const registeredRoutes = collectRegisteredPublicRoutes(app).sort();
  const documentedRoutes = collectDocumentedPublicRoutes(document).sort();
  const mountedRouteSet = new Set(mountedRoutes);
  const registeredRouteSet = new Set(registeredRoutes);
  const documentedRouteSet = new Set(documentedRoutes);

  assertContract(
    registeredRouteSet.size === registeredRoutes.length,
    "Duplicate public OpenAPI route registration",
  );

  for (const routeKey of mountedRoutes) {
    assertContract(
      documentedRouteSet.has(routeKey),
      `Undocumented public API route: ${routeKey}`,
    );
  }

  for (const routeKey of documentedRoutes) {
    assertContract(
      mountedRouteSet.has(routeKey),
      `Unmounted public API route in OpenAPI document: ${routeKey}`,
    );
    assertContract(
      registeredRouteSet.has(routeKey),
      `Unregistered public API route in OpenAPI document: ${routeKey}`,
    );
  }

  for (const routeKey of registeredRoutes) {
    assertContract(
      mountedRouteSet.has(routeKey),
      `Unmounted public OpenAPI route: ${routeKey}`,
    );
    assertContract(
      documentedRouteSet.has(routeKey),
      `Missing public OpenAPI operation: ${routeKey}`,
    );
  }

  const operationIds = new Set<string>();
  const declaredTags = new Set((document.tags ?? []).map((tag) => tag.name));

  for (const routeKey of documentedRoutes) {
    const [method, path] = routeKey.split(" ");
    const operation =
      document.paths?.[path]?.[method as (typeof HTTP_METHODS)[number]];
    assertOperationQuality(
      routeKey,
      operation,
      operationIds,
      document,
      declaredTags,
    );
  }

  assertNoExternalRefs(document);
  assertSafeExamples(document);
}

export function getOpenAPIDocument<TEnv extends Env>(
  app: OpenAPIHono<TEnv>,
  options: { validate?: boolean } = {},
) {
  const document = app.getOpenAPI31Document(openAPIConfig);
  const normalizedDocument = {
    ...document,
    components: {
      ...document.components,
      ...openAPIConfig.components,
      securitySchemes: {
        ...document.components?.securitySchemes,
        ...openAPIConfig.components.securitySchemes,
      },
    },
    tags: openAPIConfig.tags,
  } satisfies OpenAPIDocument;

  if (options.validate ?? true) {
    assertPublicApiContractQuality(app, normalizedDocument);
  }

  return normalizedDocument;
}

export function getDiscoveryDocument(document: OpenAPIDocument): OpenAPIDocument {
  // Owner client generation uses the complete local contract.
  const paths = Object.fromEntries(Object.entries(document.paths ?? {}).filter(([path]) =>
    path !== PRIVATE_RECEIPT_PATH && !path.startsWith(PRIVATE_RECEIPT_PATH + "/"),
  ));
  const { BudgetDocument: _document, BudgetReceipt: _receipt, ...schemas } = document.components?.schemas ?? {};
  return { ...document, paths, components: { ...document.components, schemas } };
}
