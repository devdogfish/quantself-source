import { agentInboxTodoPath, registerAgentInboxTodoRoutes } from "./agent-inbox-todo-route";
import { registerAgentAuditRoutes } from "./agent-audit-route";
import { createTodoDelegationReads, inaccessibleAgentTodoRoute, registerTodoDelegationRoutes } from "./todo-delegation-route";
import { registerTodoHandBackRoutes } from "./todo-handback-route";
import { OriginalStorageError } from "./original-storage";
import { registerBudgetingRoutes } from "./budgeting-route";
import { jobApplicationAddressLookupPath, jobApplicationReplyLookupPath, registerJobsRoutes } from "./jobs-route";
import { configureRoundcubeOriginalRoutes, registerRoundcubeOriginalRoutes, roundcubeOwnerPath } from "./roundcube-original-route";
import { registerJobsWorkerRoutes, type JobsWorkerRouteOptions } from "./jobs-work-route";
import { registerWebsiteAnalyticsIngestRoutes, registerWebsiteInquiryStatusRoute } from "./website-event-route";
import { registerTrackedLinkRoutes, type TrackedLinkRouteOptions } from "./tracked-links-route";
import { registerWebsiteAnalyticsReportRoutes, type WebsiteAnalyticsReportReaders } from "./website-analytics-report-route";
import { registerHabitRoutes } from "./habits-route";
import { registerNotificationRoutes } from "./notifications-route";
import { registerPhoneJarvisHistoryRoutes } from "./phone-jarvis-history-route";
import { registerJarvisConversationRoutes } from "./jarvis-conversations-route";
import { createPhoneRuntime } from "./phone-jarvis-runtime";
import { createTodoFreshness } from "./todos-freshness";
import { postgresTodoCache } from "./todos-freshness-store";
import { registerTodoFreshnessRoutes } from "./todos-freshness-route";
import { registerJarvisRoutes, type JarvisOptions } from "./todos-jarvis-route";
import { todoGitHub, type TodoReader } from "./todos-github";
import { registerTodoRoutes } from "./todos-route";
import { personalAssistantCapturePath, registerPersonalAssistantCaptureRoutes } from "./personal-assistant-capture";
import { registerMeetingRoutes, meetingsPath, type MeetingRouteOptions } from "./meetings-route";
import { productionMeetingEmail } from "./meetings-runtime";
import { registerOwnerMeetingRoutes, type OwnerMeetingRouteOptions } from "./meetings-owner-route";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ZodIssue } from "zod";
import {
  authenticateAccessContext,
  resolveAccessContext,
  type AccessContext,
  unauthenticatedError,
} from "@quantself/auth";
import { hasOwnerIngressProof, ownerIngressAllowsOrigin } from "@quantself/auth/owner-ingress";
import { Scalar } from "@scalar/hono-api-reference";
import { createMarkdownFromOpenApi } from "@scalar/openapi-to-markdown";
import { HTTPException } from "hono/http-exception";
import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import { jsonUnauthenticatedFailure } from "./authorization-response";
import {
  MARKDOWN_REFERENCE_PATH,
  OPENAPI_PATH,
  REFERENCE_PATH,
  getDiscoveryDocument,
  getOpenAPIDocument,
} from "./openapi";
import { SCALAR_BUNDLE_PATH, scalarBundleResponse } from "./scalar-assets";
import {
  type InventoryContainerMutationRunner,
  type InventoryContainersRouteHandlers,
  inventoryContainersRouteHandlers,
  registerInventoryContainerRoutes,
} from "./inventory-containers-route";
import {
  type InventoryItemsRouteHandlers,
  inventoryItemsRouteHandlers,
  registerInventoryItemRoutes,
} from "./inventory-items-route";
import {
  type InventoryClothingRecommendationsRouteHandlers,
  inventoryClothingRecommendationsRouteHandlers,
  registerInventoryClothingRecommendationRoutes,
} from "./inventory-clothing-recommendations-route";
import {
  type InventoryItemMediaRouteHandlers,
  inventoryItemMediaRouteHandlers,
  registerInventoryItemMediaRoutes,
} from "./inventory-item-media-route";
import {
  type InventoryLocationsRouteHandlers,
  inventoryLocationsRouteHandlers,
  registerInventoryLocationRoutes,
} from "./inventory-locations-route";
import {
  type InventoryWorkerRouteHandlers,
  inventoryWorkerRouteHandlers,
  registerInventoryWorkerRoutes,
} from "./inventory-worker-route";
import {
  type InventoryCaptureSessionRouteHandlers,
  type InventoryItemCaptureRouteHandlers,
  inventoryCaptureSessionRouteHandlers,
  inventoryItemCaptureRouteHandlers,
  registerInventoryCaptureRoutes,
} from "./inventory-capture-route";
import {
  toAccessContextResponse,
  accessContextRoute,
} from "./access-context-route";

type AppEnv = {
  Variables: {
    accessContext: AccessContext | null;
  };
};

type ApiAccessLogRecord = {
  accessContext: {
    ownerId: string;
    clientId: string;
    clientKind: AccessContext["client"]["kind"];
    clientName: string;
  } | null;
  auth: {
    mechanism: "api-key" | "none" | "owner-ingress";
    outcome: "anonymous" | "authenticated" | "invalid";
  };
  elapsedMs: number;
  method: string;
  outcome: "completed" | "failed" | "rejected";
  route: string;
  status: number;
  timestamp: string;
};

type CreateAppOptions = {
  shutdownSignal?: AbortSignal;
  todos?: TodoReader;
  todoDelegation?: { db: import("@quantself/db/generated/prisma/client").PrismaClient; directory?: Parameters<typeof registerTodoDelegationRoutes>[3] };
  jarvis?: JarvisOptions;
  emitAccessLog?: (record: ApiAccessLogRecord) => Promise<void> | void;
  inventoryClothingRecommendations?: Partial<InventoryClothingRecommendationsRouteHandlers>;
  inventoryContainerMutationRunner?: InventoryContainerMutationRunner;
  inventoryContainers?: Partial<InventoryContainersRouteHandlers>;
  inventoryCaptureSession?: InventoryCaptureSessionRouteHandlers;
  inventoryLocations?: Partial<InventoryLocationsRouteHandlers>;
  inventoryItemCapture?: InventoryItemCaptureRouteHandlers;
  inventoryItemMedia?: Partial<InventoryItemMediaRouteHandlers>;
  inventoryItems?: Partial<InventoryItemsRouteHandlers>;
  inventoryWorkers?: Partial<InventoryWorkerRouteHandlers>;
  jobsWorkers?: JobsWorkerRouteOptions;
  jobsRoundcubeEnv?: Parameters<typeof configureRoundcubeOriginalRoutes>[1];
  meetings?: MeetingRouteOptions;
  ownerMeetings?: OwnerMeetingRouteOptions;
  trackedLinks?: TrackedLinkRouteOptions;
  websiteAnalyticsReports?: Partial<WebsiteAnalyticsReportReaders>;
  registerRoutes?: (app: OpenAPIHono<AppEnv>) => void;
  resolveAccessContext?: (headers: Headers) => Promise<AccessContext | null>;
  unsafeSkipContractValidationForTests?: boolean;
};

function resolveAuthMechanism(
  headers: Headers,
  accessContext: AccessContext | null,
) {
  if (accessContext?.client.kind === "api-key" || accessContext?.client.kind === "agent") {
    return "api-key" as const;
  }

  if (accessContext?.client.kind === "web") {
    return "owner-ingress" as const;
  }

  if (headers.has("x-api-key")) {
    return "api-key" as const;
  }

  return "none" as const;
}

function buildAccessLogRecord(input: {
  accessContext: AccessContext | null;
  elapsedMs: number;
  headers: Headers;
  method: string;
  route: string;
  status: number;
}) {
  const mechanism = resolveAuthMechanism(input.headers, input.accessContext);
  const outcome =
    input.status >= 500
      ? "failed"
      : input.status >= 400
        ? "rejected"
        : "completed";

  return {
    accessContext: input.accessContext
      ? {
          ownerId: input.accessContext.owner.id,
          clientId: input.accessContext.client.id,
          clientKind: input.accessContext.client.kind,
          clientName: input.accessContext.client.name,
        }
      : null,
    auth: {
      mechanism,
      outcome:
        mechanism === "none"
          ? "anonymous"
          : input.accessContext
            ? "authenticated"
            : "invalid",
    },
    elapsedMs: Math.round(input.elapsedMs),
    method: input.method,
    outcome,
    route: input.route,
    status: input.status,
    timestamp: new Date().toISOString(),
  } satisfies ApiAccessLogRecord;
}

function defaultEmitAccessLog(record: ApiAccessLogRecord) {
  console.info(JSON.stringify(record));
}

async function tryEmitAccessLog(
  emitAccessLog: NonNullable<CreateAppOptions["emitAccessLog"]>,
  record: ApiAccessLogRecord,
) {
  try {
    await emitAccessLog(record);
  } catch {
    // Access-log delivery must not change the API response.
  }
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, context) => {
      if (result.success) {
        return;
      }

      if (/^\/api\/v1\/todo-jarvis\/[^/]+\/commands$/.test(context.req.path)) {
        const describe = (issue: ZodIssue, prefix: PropertyKey[] = []): string[] => {
          const path = [...prefix, ...issue.path];
          return issue.code === "invalid_union"
            ? issue.errors.flatMap(branch => branch.flatMap(child => describe(child, path)))
            : [`${path.join(".")}: ${issue.message}`];
        };
        const details = [...new Set(result.error.issues.flatMap(issue => describe(issue)))].slice(0, 12).join("; ");
        return context.json({ code: "INVALID_REQUEST", message: `Jarvis command validation failed. ${details}` }, 400);
      }

      if (/^\/api\/v1\/budgeting\/tax-planning(?:\/|$)/.test(context.req.path)) {
        return context.json({ message: "Invalid tax planning request." }, 400);
      }
      if (context.req.path.startsWith("/api/v1/tracked-links/")) {
        return context.json({ code: "INVALID_REQUEST" }, 400);
      }
      const idempotencyKey = context.req.header("idempotency-key")?.trim();
      if (context.req.path === meetingsPath || context.req.path.startsWith(`${meetingsPath}/`)) {
        const needsKey = context.req.method === "POST" && context.req.path === meetingsPath &&
          (!idempotencyKey || idempotencyKey.length > 255);
        return context.json(needsKey
          ? { code: "INVALID_IDEMPOTENCY_KEY", message: "Idempotency-Key header is required and must not exceed 255 characters." }
          : { code: "INVALID_REQUEST", message: "Request validation failed." }, 400);
      }
      if (context.req.path.startsWith("/api/v1/jobs/")) {
        const needsKey = result.error.issues.some(issue => issue.path[0] === "idempotency-key");
        const message = needsKey || (idempotencyKey?.length ?? 0) > 200
          ? "Use an Idempotency-Key with no more than 200 characters."
          : "Invalid Jobs request.";
        return context.json({ message }, 400);
      }
      const invalidIdempotencyKey =
        (context.req.method === "POST" || context.req.method === "PUT") &&
        context.req.path !== "/api/v1/habits/commands"
          ? !idempotencyKey || idempotencyKey.length > 255
          : false;

      return context.json(
        invalidIdempotencyKey
          ? {
              code: "INVALID_IDEMPOTENCY_KEY",
              message:
                "Idempotency-Key header is required and must not exceed 255 characters.",
            }
          : {
              code: "INVALID_REQUEST",
              message: "Request validation failed.",
            },
        400,
      );
    },
  });
  const emitAccessLog = options.emitAccessLog ?? defaultEmitAccessLog;
  const inventoryContainers = {
    ...inventoryContainersRouteHandlers,
    ...options.inventoryContainers,
  } satisfies InventoryContainersRouteHandlers;
  const inventoryClothingRecommendations = {
    ...inventoryClothingRecommendationsRouteHandlers,
    ...options.inventoryClothingRecommendations,
  } satisfies InventoryClothingRecommendationsRouteHandlers;
  const inventoryCaptureSession =
    options.inventoryCaptureSession ?? inventoryCaptureSessionRouteHandlers;
  const inventoryLocations = {
    ...inventoryLocationsRouteHandlers,
    ...options.inventoryLocations,
  } satisfies InventoryLocationsRouteHandlers;
  const inventoryItemCapture =
    options.inventoryItemCapture ?? inventoryItemCaptureRouteHandlers;
  const inventoryItemMedia = {
    ...inventoryItemMediaRouteHandlers,
    ...options.inventoryItemMedia,
  } satisfies InventoryItemMediaRouteHandlers;
  const inventoryWorkers = {
    ...inventoryWorkerRouteHandlers,
    ...options.inventoryWorkers,
  } satisfies InventoryWorkerRouteHandlers;
  const inventoryItems = {
    ...inventoryItemsRouteHandlers,
    ...options.inventoryItems,
  } satisfies InventoryItemsRouteHandlers;
  const resolveRequestAccessContext =
    options.resolveAccessContext ?? resolveAccessContext;
  const openAPIDocument = () =>
    getOpenAPIDocument(app, {
      validate: !options.unsafeSkipContractValidationForTests,
    });
  const discoveryDocument = () => getDiscoveryDocument(openAPIDocument());

  app.onError((error, context) =>
    error instanceof OriginalStorageError
      ? Response.json({ code: error.code, message: error.message }, { status: error.status })
      : error instanceof HTTPException
      ? error.getResponse()
      : context.text("Internal Server Error", 500),
  );

  app.get("/api/health", (context) =>
    context.json({
      service: "quantself-api",
      status: "ok",
    }),
  );

  // Provider callbacks authenticate their Twilio signature before the ordinary API-key middleware.
  if (!options.todos) productionPhoneRuntime?.register(app);
  // Portfolio ingest uses its own credential instead of a general API key or Owner session.
  registerWebsiteAnalyticsIngestRoutes(app);

  // These exact routes use registry credentials and a single lookup for redirects.
  registerTrackedLinkRoutes(app, options.trackedLinks);

  const authenticateApi = createMiddleware<AppEnv>(async (context, next) => {
    const startedAt = performance.now();
    const headers = context.req.raw.headers;
    let accessContext: AccessContext | null = null;
    let errorStatus: number | null = null;

    try {
      if (!headers.has("x-api-key") && hasOwnerIngressProof(headers)) {
        context.header("Cache-Control", "private, no-store");
        if (!ownerIngressAllowsOrigin(headers, context.req.method)) {
          errorStatus = 403;
          return context.json({ code: "FORBIDDEN", message: "Invalid request origin." }, 403);
        }
      }
      accessContext = await resolveRequestAccessContext(headers);
      context.set("accessContext", accessContext);
      if (!accessContext) {
        errorStatus = 401;
        return jsonUnauthenticatedFailure(context, unauthenticatedError);
      }
      const todoSuggestionReview = context.req.method === "POST" && context.req.path === "/api/v1/todo-suggestions/review";
      const todoHandBack = context.req.method === "POST" && /^\/api\/v1\/todos\/[1-9]\d*\/hand-back$/.test(context.req.path);
      const personalAssistantCapture = context.req.method === "POST" && context.req.path === personalAssistantCapturePath;
      const agentInboxCreation = context.req.method === "POST" && context.req.path === agentInboxTodoPath;
      const applicationLookup = context.req.method === "POST" &&
        (context.req.path === jobApplicationAddressLookupPath || context.req.path === jobApplicationReplyLookupPath);
      if (accessContext.client.kind === "agent" && !todoSuggestionReview && !todoHandBack && inaccessibleAgentTodoRoute(context.req.path)) {
        context.header("Cache-Control", "no-store");
        return context.json({ code: "FORBIDDEN", message: "Agent Clients can only read their assigned To-Dos." }, 403);
      }
      if (accessContext.client.kind === "agent" &&
        !["GET", "HEAD"].includes(context.req.method) &&
        !todoSuggestionReview && !todoHandBack && !applicationLookup && !personalAssistantCapture && !agentInboxCreation &&
        !(context.req.method === "PATCH" && routePath(context, -1) === "/api/v1/jobs/applications/:id") &&
        !(context.req.method === "POST" && routePath(context, -1) === "/api/v1/jobs/applications/:id/interviews/native")) {
        context.header("Cache-Control", "no-store");
        return context.json({
          code: "FORBIDDEN",
          message: "This operation does not support audited, revision-checked Agent writes with Undo.",
        }, 403);
      }
      await next();
    } catch (error) {
      errorStatus = error instanceof HTTPException ? error.status : 500;
      throw error;
    } finally {
      let matchedRoute: string;
      try {
        matchedRoute = routePath(context, -1) || "/api/v1/*";
      } catch {
        matchedRoute = "/api/v1/*";
      }

      await tryEmitAccessLog(
        emitAccessLog,
        buildAccessLogRecord({
          accessContext,
          elapsedMs: performance.now() - startedAt,
          headers,
          method: context.req.method,
          route: matchedRoute,
          status: errorStatus ?? context.res.status,
        }),
      );
    }
  });
  app.use("/api/v1/*", authenticateApi);
  app.use(`${roundcubeOwnerPath}/*`, authenticateApi);

  app.openapi(accessContextRoute, (context) => {
    const authorization = authenticateAccessContext(
      context.get("accessContext"),
    );
    if (!authorization.ok) {
      return jsonUnauthenticatedFailure(context, authorization.error);
    }

    return context.json(
      toAccessContextResponse(authorization.accessContext),
      200,
    );
  });

  registerInventoryClothingRecommendationRoutes(
    app,
    inventoryClothingRecommendations,
  );
  registerInventoryItemRoutes(app, inventoryItems);
  registerInventoryItemMediaRoutes(app, inventoryItemMedia);
  registerInventoryLocationRoutes(app, inventoryLocations);
  registerInventoryContainerRoutes(
    app,
    inventoryContainers,
    options.inventoryContainerMutationRunner,
  );
  registerInventoryCaptureRoutes(
    app,
    inventoryCaptureSession,
    inventoryItemCapture,
  );
  registerInventoryWorkerRoutes(app, inventoryWorkers);
  const todos = options.todos ?? productionTodoFreshness.reader;
  const notifyTodoProjection = options.todos ? undefined : productionTodoFreshness.projectChanged;
  const delegationReads = options.todos && !options.todoDelegation ? undefined : createTodoDelegationReads(options.todoDelegation?.db, notifyTodoProjection);
  if (!options.todos) registerTodoFreshnessRoutes(app, productionTodoFreshness, { resolveAccessContext: resolveRequestAccessContext, shutdownSignal: options.shutdownSignal, projectTodos: delegationReads?.project });
  registerTodoRoutes(app, todos, delegationReads, options.todoDelegation?.db);
  registerPersonalAssistantCaptureRoutes(app, todos, options.todoDelegation?.db);
  registerTodoDelegationRoutes(app, todos, options.todoDelegation?.db, options.todoDelegation?.directory, notifyTodoProjection);
  registerTodoHandBackRoutes(app, todos, delegationReads, options.todoDelegation?.db, notifyTodoProjection);
  registerNotificationRoutes(app, todos);
  registerHabitRoutes(app);
  // Owner routes first so `/meetings/booked` and `/meetings/settings` never reach the booking routes.
  registerOwnerMeetingRoutes(app, options.ownerMeetings ?? { onChange: productionMeetingEmail?.kick });
  registerMeetingRoutes(app, todos, options.meetings ?? { onChange: productionMeetingEmail?.kick });
  registerBudgetingRoutes(app);
  const roundcube = configureRoundcubeOriginalRoutes(options.jobsWorkers?.db, options.jobsRoundcubeEnv);
  registerJobsRoutes(app, options.jobsWorkers?.db, options.jobsWorkers?.pdfStore?.open, todos.write, roundcube?.readAvailability);
  registerRoundcubeOriginalRoutes(app, roundcube);
  registerJobsWorkerRoutes(app, options.jobsWorkers);
  registerWebsiteInquiryStatusRoute(app);
  registerWebsiteAnalyticsReportRoutes(app, options.websiteAnalyticsReports);
  registerAgentInboxTodoRoutes(app, options.todoDelegation?.db);
  registerAgentAuditRoutes(app, options.todoDelegation?.db, todos, notifyTodoProjection);
  registerJarvisRoutes(app, todos, options.jarvis);
  registerPhoneJarvisHistoryRoutes(app);
  registerJarvisConversationRoutes(app);

  app.get(OPENAPI_PATH, (context) => context.json(discoveryDocument()));

  app.get(SCALAR_BUNDLE_PATH, () => scalarBundleResponse());

  app.get(
    REFERENCE_PATH,
    Scalar({
      url: OPENAPI_PATH,
      pageTitle: "QuantSelf API Reference",
      cdn: SCALAR_BUNDLE_PATH,
      agent: {
        disabled: true,
      },
      persistAuth: false,
      proxyUrl: "",
      telemetry: false,
      withDefaultFonts: false,
    }),
  );

  app.get(MARKDOWN_REFERENCE_PATH, async (context) => {
    const markdown = await createMarkdownFromOpenApi(
      JSON.stringify(discoveryDocument()),
    );
    return context.text(markdown, 200, {
      "content-type": "text/markdown; charset=utf-8",
    });
  });

  app.get("/llms.txt", (context) =>
    context.text(
      [
        "# QuantSelf",
        "",
        "> Self-hosted personal operating system API.",
        "",
        "Use X-API-Key authentication with the least-privilege permissions required.",
        "",
        "Read the Inventory write quick reference in the OpenAPI overview before creating Food, Supplement, Clothing, or Remedy records.",
        "",
        `- [OpenAPI document](${OPENAPI_PATH}): Machine-readable API reference.`,
        `- [API reference](${MARKDOWN_REFERENCE_PATH}): Generated Markdown reference.`,
        `- [Interactive API reference](${REFERENCE_PATH}): Human-oriented Scalar reference.`,
        "",
      ].join("\n"),
      200,
      {
        "content-type": "text/markdown; charset=utf-8",
      },
    ),
  );

  options.registerRoutes?.(app);
  if (!options.unsafeSkipContractValidationForTests) {
    openAPIDocument();
  }

  return app;
}

export const productionTodoFreshness = createTodoFreshness(todoGitHub, postgresTodoCache(`single-owner:${process.env.QUANTSELF_GITHUB_INSTALLATION_ID}:${process.env.QUANTSELF_TODO_REPOSITORY}:v1`));
export const productionPhoneRuntime = createPhoneRuntime(productionTodoFreshness.reader);
export const productionShutdown = new AbortController();
export const app = createApp({ shutdownSignal: productionShutdown.signal });
