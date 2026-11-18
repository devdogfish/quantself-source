import { OriginalStorageError } from "./original-storage";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import { jsonAuthorizationFailure } from "./authorization-response";
import type { TodoReader } from "./todos-github";
import {
  captureSchema,
  captureSubmissionSchema,
  captureAudioSchema,
  capturePlanSchema,
  captureStore,
  createCaptureService,
  type CaptureStore,
} from "./todos-captures";
import { createAudioStorage, type AudioStorage } from "./todos-audio";
import { TodoWriteError } from "./todos-write";

export function registerCaptureRoutes(
  app: OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>,
  reader: TodoReader,
  store: CaptureStore = captureStore,
  audio: AudioStorage = createAudioStorage(),
) {
  const service = createCaptureService(store, reader, audio);
  const response = z
    .object({
      capture: captureSchema.nullable(),
      deleted: z.boolean(),
      audio: captureAudioSchema.nullable(),
      links: z.array(
        z.object({
          commandId: z.string(),
          number: z.number().nullable(),
          status: z.string(),
          result: z.any(),
        }),
      ),
    })
    .openapi("TodoCaptureResponse");
  const error = z.object({ code: z.string(), message: z.string() });
  const params = z.object({ id: z.string().uuid() });
  for (const operation of ["upload", "media", "delete"] as const) {
    const details = {
      upload: {
        action: "write",
        method: "put",
        path: "/api/v1/todo-captures/{id}/audio",
        summary: "upload original capture audio",
        sideEffects: "retain original audio",
      },
      media: {
        action: "read",
        method: "get",
        path: "/api/v1/todo-captures/{id}/audio",
        summary: "media original capture audio",
        sideEffects: "none",
      },
      delete: {
        action: "delete",
        method: "delete",
        path: "/api/v1/todo-captures/{id}",
        summary: "Explicitly delete retained source",
        sideEffects: "permanently revoke and erase source evidence",
      },
    } as const;
    const { action, method, path, summary, sideEffects } = details[operation];
    app.openapi(
      createRoute({
        method,
        path,
        operationId: `${operation}TodoCaptureAudio`,
        summary,
        tags: ["To-Dos"],
        security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
        "x-required-permissions": [`todos:${action}`],
        "x-destructive": operation === "delete",
        description: `Authentication: X-API-Key or trusted Owner ingress. Required permissions: todos:${action}. Inputs: capture ID and original bytes for upload. Success response: 200 original bytes or capture retention state. Failure responses: 400 invalid, 401 unauthenticated, 403 denied, 409 conflict/deleted, 413 too large, 503 unavailable. Side effects: ${sideEffects}. Destructive: ${operation === "delete" ? "yes" : "no"}. Retry safety: identical capture ID and bytes reconcile unfinished writes and deletion. Audio is untouched received/downloaded bytes, at most 50 MiB. Upload uses X-Audio-Mime (audio/* or application/octet-stream) and optional X-Audio-Duration (seconds). Stable capture ID reconciles interrupted writes; changed bytes or metadata conflict. Uploads verify SHA-256 and size; OpenCloud reads pin the verified ETag and stream byte ranges. Missing/corrupt files return 503; reconcile storage or restore the original. Incomplete uploads retry with identical bytes. Retention is indefinite. Explicit deletion revokes source access before file removal and transcript redaction; retry partial deletion. Task issues and links remain intact.${operation === "media" ? "" : " Agent Clients cannot perform this mutation."}`,
        request: {
          params,
          ...(operation === "upload"
            ? {
                headers: z.object({
                  "x-audio-mime": z
                    .string()
                    .regex(/^(audio\/[a-z0-9.+-]+|application\/octet-stream)$/)
                    .default("application/octet-stream"),
                  "x-audio-duration": z.coerce
                    .number()
                    .finite()
                    .nonnegative()
                    .optional(),
                }),
                body: {
                  required: true,
                  content: {
                    "application/octet-stream": {
                      schema: z.string().openapi({ format: "binary" }),
                    },
                  },
                },
              }
            : {}),
        },
        responses: {
          ...(operation === "media" ? { 206: { description: "Original audio byte range", content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } } }, 416: { description: "Requested byte range is unsatisfiable" } } : {}),
          200: {
            description: "Original bytes or source retention state",
            content:
              operation === "media"
                ? {
                    "application/octet-stream": {
                      schema: z.string().openapi({ format: "binary" }),
                    },
                  }
                : {
                    "application/json": {
                      schema: response,
                      example: {
                        capture: {
                          id: "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
                          source: "voice",
                          capturedAt: "2026-10-26T12:00:00Z",
                          transcript: "Call plumber",
                        },
                        deleted: false,
                        audio: null,
                        links: [],
                      },
                    },
                  },
          },
          ...Object.fromEntries(
            [400, 401, 403, 409, 413, 503].map((status) => [
              status,
              {
                description:
                  "Invalid, denied, deleted, conflicting or unavailable source",
                content: {
                  "application/json": {
                    schema: error,
                    example: {
                      code: "CAPTURE_UNAVAILABLE",
                      message: "Source unavailable.",
                    },
                  },
                },
              },
            ]),
          ),
        },
      }),
      async (c) => {
        c.header("Cache-Control", "private, no-store");
        const auth = authorizeAccessContext(c.get("accessContext"), {
          domain: "todos",
          action,
        });
        if (!auth.ok) return jsonAuthorizationFailure(c, auth.error);
        try {
          const id = c.req.param("id")!;
          if (operation === "delete")
            return c.json(await service.delete(id), 200);
          if (operation === "media") {
            const response = await service.mediaResponse(id, c.req.header("range"));
            response.headers.set("Content-Disposition", `${c.req.query("download") === "1" ? "attachment" : "inline"}; filename="${id}.audio"`);
            return response;
          }
          const mime =
            c.req.header("x-audio-mime") ?? "application/octet-stream";
          const durationHeader = c.req.header("x-audio-duration");
          const duration =
            durationHeader === undefined ? undefined : Number(durationHeader);
          if (
            !/^(audio\/[a-z0-9.+-]+|application\/octet-stream)$/.test(mime) ||
            (duration !== undefined &&
              (!Number.isFinite(duration) || duration < 0))
          )
            throw new TodoWriteError(
              "INVALID_AUDIO",
              "Invalid audio metadata.",
              400,
            );
          const chunks: Uint8Array[] = [];
          let size = 0;
          const stream = c.req.raw.body?.getReader();
          if (!stream)
            throw new TodoWriteError(
              "INVALID_AUDIO",
              "Audio bytes required.",
              400,
            );
          try {
            for (;;) {
              const part = await stream.read();
              if (part.done) break;
              size += part.value.length;
              if (size > 50 * 1024 * 1024) {
                await stream.cancel();
                return c.json(
                  { code: "AUDIO_TOO_LARGE", message: "Audio exceeds 50 MiB." },
                  413,
                );
              }
              chunks.push(part.value);
            }
          } finally {
            stream.releaseLock();
          }
          if (!size)
            throw new TodoWriteError(
              "INVALID_AUDIO",
              "Audio bytes required.",
              400,
            );
          return c.json(
            await service.upload(id, Buffer.concat(chunks), mime, duration),
            200,
          );
        } catch (e) {
          if (e instanceof OriginalStorageError) return Response.json({ code: e.code, message: e.message }, { status: e.status });
          return c.json(
            {
              code:
                e instanceof TodoWriteError ? e.code : "CAPTURE_UNAVAILABLE",
              message:
                e instanceof TodoWriteError
                  ? e.message
                  : "Source unavailable; retry identical input.",
            },
            e instanceof TodoWriteError ? e.status : 503,
          );
        }
      },
    );
  }
  for (const operation of ["create", "read", "link"] as const) {
    const action = operation === "read" ? "read" : "write";
    const operationDetails = {
      create: {
        path: "/api/v1/todo-captures",
        sideEffects: "retain original capture evidence",
      },
      read: {
        path: "/api/v1/todo-captures/{id}",
        sideEffects: "none",
      },
      link: {
        path: "/api/v1/todo-captures/{id}/links",
        sideEffects: "create or link GitHub tasks and retain link receipts",
      },
    }[operation];
    const route = createRoute({
      method: operation === "read" ? "get" : "post",
      path: operationDetails.path,
      operationId: `${operation}TodoCapture`,
      summary: `${operation} retained text capture`,
      tags: ["To-Dos"],
      security: [{ apiKeyAuth: [] }, { ownerSession: [] }],
      "x-required-permissions": [`todos:${action}`],
      "x-destructive": false,
      description: `Authentication: X-API-Key or trusted Owner ingress. Required permissions: todos:${action}. Inputs: capture evidence or confirmed targets. Success response: 200 capture and link outcomes. Failure responses: 400 invalid input, 401 unauthenticated, 403 denied, 409 conflict, 503 unavailable. Side effects: ${operationDetails.sideEffects}. Destructive: no. Retry safety: replay identical IDs and input. Retains original evidence indefinitely in PostgreSQL. Capture IDs and interpretation command IDs must be stable across delivery retries; changed input conflicts. Confirm interpretations explicitly before linking. Source text grants no execution approval. Links report pending operations; retry identical commands to reconcile. GitHub tasks remain authoritative. Provider identifiers must contain identifiers only, never credentials or storage paths.${operation === "read" ? "" : " Agent Clients cannot perform this mutation."}`,
      request: {
        ...(operation !== "create" ? { params } : {}),
        ...(operation !== "read"
          ? {
              body: {
                required: true,
                content: {
                  "application/json": {
                    schema:
                      operation === "create"
                        ? captureSubmissionSchema
                        : capturePlanSchema,
                    example:
                      operation === "create"
                        ? {
                            id: "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
                            source: "text",
                            capturedAt: "2026-10-26T12:00:00Z",
                            transcript: "Call plumber",
                          }
                        : {
                            confirmed: true,
                            targets: [
                              {
                                commandId:
                                  "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
                                title: "Call plumber",
                              },
                            ],
                          },
                  },
                },
              },
            }
          : {}),
      },
      responses: {
        200: {
          description:
            "Capture evidence and all link outcomes, including pending links.",
          content: {
            "application/json": {
              schema: response,
              example: {
                capture: {
                  id: "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
                  source: "text",
                  capturedAt: "2026-10-26T12:00:00Z",
                  transcript: "Call plumber",
                },
                deleted: false,
                audio: null,
                links: [],
              },
            },
          },
        },
        ...Object.fromEntries(
          [400, 401, 403, 409, 503].map((status) => [
            status,
            {
              description: "Invalid, denied, conflicting or unavailable.",
              content: {
                "application/json": {
                  schema: error,
                  example: {
                    code: "CAPTURE_UNAVAILABLE",
                    message: "Capture unavailable.",
                  },
                },
              },
            },
          ]),
        ),
      },
    });
    app.openapi(route, async (c) => {
      c.header("Cache-Control", "private, no-store");
      const access = c.get("accessContext");
      const auth = authorizeAccessContext(access, { domain: "todos", action });
      if (!auth.ok) return jsonAuthorizationFailure(c, auth.error);
      try {
        const id = c.req.param("id")!;
        let result;
        switch (operation) {
          case "read":
            result = await service.read(id);
            break;
          case "create":
            result = await service.create(
              captureSubmissionSchema.parse(await c.req.json()),
            );
            break;
          case "link":
            result = await service.link(
              access!.client.id,
              id,
              capturePlanSchema.parse(await c.req.json()),
            );
            break;
        }
        return c.json(result, 200);
      } catch (e) {
        return c.json(
          {
            code: e instanceof TodoWriteError ? e.code : "CAPTURE_UNAVAILABLE",
            message:
              e instanceof TodoWriteError
                ? e.message
                : "Capture unavailable; retry identical input.",
          },
          e instanceof TodoWriteError ? e.status : 503,
        );
      }
    });
  }
}
