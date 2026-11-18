import { registerJarvisCommands } from "./todos-jarvis-commands";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import { jsonAuthorizationFailure } from "./authorization-response";
import {
  captureStore,
  createCaptureService,
  type CaptureStore,
} from "./todos-captures";
import { createAudioStorage, type AudioStorage } from "./todos-audio";
import type { TodoReader } from "./todos-github";
import { TodoWriteError } from "./todos-write";
import {
  createJarvisProvider,
  jarvisConflict,
  type JarvisProvider,
} from "./todos-jarvis";

export type JarvisOptions = {
  store?: CaptureStore;
  audio?: AudioStorage;
  provider?: JarvisProvider;
};
export function registerJarvisRoutes(
  app: OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>,
  reader: TodoReader,
  {
    store = captureStore,
    audio = createAudioStorage(),
    provider = createJarvisProvider(),
  }: JarvisOptions = {},
) {
  const captures = createCaptureService(store, reader, audio);
  registerJarvisCommands(app, reader, store, provider);
  const response = z
    .object({
      captureId: z.string().uuid(),
      status: z.enum(["connecting", "pending", "archived"]),
      signedUrl: z.string().optional(),
    })
    .openapi("JarvisSession");
  const error = z.object({ code: z.string(), message: z.string() });
  const failure = {
    description: "Jarvis unavailable or request denied",
    content: {
      "application/json": {
        schema: error,
        example: {
          code: "JARVIS_UNAVAILABLE",
          message: "Jarvis unavailable; retry.",
        },
      },
    },
  };
  for (const operation of ["access", "reconcile"] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/api/v1/todo-jarvis/{id}/${operation}`,
        operationId: `${operation}TodoJarvis`,
        summary:
          operation === "access"
            ? "Start private Jarvis"
            : "Reconcile final Jarvis recording",
        tags: ["To-Dos"],
        security: [{ ownerSession: [] }],
        "x-required-permissions": ["todos:read"],
        "x-destructive": false,
        description:
          "Authentication: trusted Owner ingress only. Required permissions: todos:read. Inputs: stable capture UUID; reconcile additionally takes provider conversationId. No credential, repository, agent or callback overrides. Success response: 200 temporary access or verified archive, 202 final recording pending. Failure responses: 400 invalid, 401 unauthenticated, 403 denied, 409 source conflict/deleted, 503 unavailable. Side effects: retain this Owner's conversation transcript and untouched original audio only; never edits tasks or approves execution. Destructive: no. Retry safety: repeat capture ID and conversation ID to reconcile one archive; archive is complete only after verified bytes exist. Temporary access retries may issue another short-lived URL; connect once and retain the conversation ID. Provider tools use authenticated task and access-context reads and the shared conversational command endpoint with provider secret references; execution approval remains a separate Owner control.",
        request: {
          params: z.object({ id: z.string().uuid() }),
          body: {
            required: true,
            content: {
              "application/json": {
                schema:
                  operation === "access"
                    ? z.object({}).strict()
                    : z
                        .object({
                          conversationId: z
                            .string()
                            .regex(/^[\w-]+$/)
                            .max(256),
                        })
                        .strict(),
                example:
                  operation === "access"
                    ? {}
                    : { conversationId: "conv_example" },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Temporary access or complete archive",
            content: {
              "application/json": {
                schema: response,
                example: {
                  captureId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
                  status: "archived",
                },
              },
            },
          },
          202: {
            description: "Provider processing; retry after delay",
            content: {
              "application/json": {
                schema: response,
                example: {
                  captureId: "5d72f10e-99cc-4d46-8bf8-d09f420ba453",
                  status: "pending",
                },
              },
            },
          },
          400: failure,
          401: failure,
          403: failure,
          409: failure,
          503: failure,
        },
      }),
      async (c) => {
        c.header("Cache-Control", "private, no-store");
        const access = c.get("accessContext");
        const auth = authorizeAccessContext(access, "todos:read");
        if (!auth.ok) return jsonAuthorizationFailure(c, auth.error);
        if (access!.client.kind !== "web")
          return c.json(
            { code: "FORBIDDEN", message: "Owner Session required." },
            403,
          );
        const id = c.req.valid("param").id;
        try {
          if (await store.get(`deleted:${id}`))
            throw new TodoWriteError(
              "CAPTURE_DELETED",
              "Source deleted by Owner.",
              409,
            );
          const session = await store.get(`jarvis:${id}`);
          if (session && session.input.owner !== access!.owner.id)
            throw jarvisConflict();
          if (operation === "access") {
            if (await store.get(`jarvis-binding:${id}`)) throw jarvisConflict();
            await store.reserve(`jarvis:${id}`, {
              owner: access!.owner.id,
              id,
            });
            return c.json(
              {
                captureId: id,
                status: "connecting" as const,
                signedUrl: await provider.temporaryAccess(),
              },
              200,
            );
          }
          if (!session) throw jarvisConflict();
          const { conversationId } = z
            .object({ conversationId: z.string() })
            .parse(c.req.valid("json"));
          const final = await provider.finalConversation(conversationId);
          if (
            final.agentId !== provider.agentId() ||
            final.userId !== id ||
            final.conversationId !== conversationId
          )
            throw jarvisConflict();
          const prior = await store.get(`jarvis-binding:${id}`);
          if (prior && prior.input.conversationId !== conversationId)
            throw jarvisConflict();
          await store.reserve(`jarvis-binding:${id}`, { conversationId });
          await store.reserve(`jarvis-source:${conversationId}`, { id });
          if (!final.done) {
            c.header("Retry-After", "5");
            return c.json({ captureId: id, status: "pending" as const }, 202);
          }
          await captures.create({
            id,
            source: "jarvis",
            capturedAt: final.capturedAt,
            provider: { name: "elevenlabs", conversationId },
            conversation: final.conversation,
          });
          // Re-read verified bytes even on replay: metadata alone does not prove an archive.
          try {
            await captures.media(id);
          } catch {
            const media = await provider.audio(conversationId);
            await captures.upload(id, media.bytes, media.mime);
            await captures.media(id);
          }
          return c.json({ captureId: id, status: "archived" as const }, 200);
        } catch (e) {
          return c.json(
            {
              code: e instanceof TodoWriteError ? e.code : "JARVIS_UNAVAILABLE",
              message:
                e instanceof TodoWriteError
                  ? e.message
                  : "Jarvis unavailable or recording pending; retry the same capture.",
            },
            e instanceof TodoWriteError ? e.status : 503,
          );
        }
      },
    );
  }
}
