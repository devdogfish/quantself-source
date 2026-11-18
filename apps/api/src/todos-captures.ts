import { originalsEnabled, assertOriginalWritesEnabled } from "./original-storage";
import { audioBytesResponse } from "./todos-audio";
import { createAudioStorage, type AudioStorage } from "./todos-audio";
import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import type { TodoReader } from "./todos-github";
import { todoCreateSchema, TodoWriteError } from "./todos-write";

export const captureSchema = z
  .object({
    id: z.string().uuid(),
    source: z.string().trim().min(1).max(100),
    capturedAt: z.string().datetime({ offset: true }),
    transcript: z
      .string()
      .min(1)
      .max(30000)
      .refine(
        (text) =>
          !/(?:authorization|proxy-authorization|x-api-key|cookie|set-cookie)["']?\s*:/i.test(
            text,
          ),
        "Submit conversational text only; authentication headers are forbidden.",
      ),
    provider: z
      .object({
        name: z.string().max(100),
        conversationId: z.string().max(256).optional(),
        deliveryId: z.string().max(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .openapi("TodoCapture");
// Conversation messages are a separate input from provider execution/transport traces.
// Accept only displayed speech/text; never serialize arbitrary provider payloads.
export const captureSubmissionSchema = captureSchema
  .omit({ transcript: true })
  .extend({
    transcript: captureSchema.shape.transcript.optional(),
    conversation: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: captureSchema.shape.transcript,
          })
          .strict(),
      )
      .min(1)
      .max(500)
      .optional(),
  })
  .strict()
  .refine(
    (input) => Boolean(input.transcript) !== Boolean(input.conversation),
    "Supply transcript text or conversational messages, exclusively.",
  )
  .openapi("TodoCaptureSubmission");
export const capturePlanSchema = z
  .object({
    confirmed: z.literal(true),
    targets: z
      .array(
        todoCreateSchema.extend({
          number: z.number().int().positive().safe().optional(),
        }),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine(
    (v) => new Set(v.targets.map((t) => t.commandId)).size === v.targets.length,
    "Command IDs must be unique.",
  )
  .openapi("TodoCapturePlan");
type Row = { input: any; result: any };
export type CaptureStore = {
  reserve(key: string, input: unknown): Promise<Row>;
  get(key: string): Promise<Row | null>;
  save(key: string, result: unknown): Promise<void>;
  list(prefix: string): Promise<Row[]>;
  redact?(key: string): Promise<void>;
};
const canonical = (input: unknown): string =>
  JSON.stringify(input, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
// Permanent archive metadata, not expiring HTTP receipts or canonical task facts.
export const captureStore: CaptureStore = {
  async reserve(key, input) {
    const { prisma } = await import("@quantself/db");
    const hash = createHash("sha256").update(canonical(input)).digest("hex");
    const where = {
      clientId_operation_idempotencyKey: {
        clientId: "todos",
        operation: "capture-archive",
        idempotencyKey: key,
      },
    };
    try {
      await prisma.apiIdempotencyKey.create({
        data: {
          ...where.clientId_operation_idempotencyKey,
          requestFingerprint: hash,
          responseBody: {
            input: JSON.parse(JSON.stringify(input)),
            result: null,
          },
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
    }
    const row = await prisma.apiIdempotencyKey.findUniqueOrThrow({ where });
    if (row.requestFingerprint !== hash)
      throw new TodoWriteError(
        "CAPTURE_CONFLICT",
        "Capture or interpretation ID already used with different input.",
      );
    return row.responseBody as Row;
  },
  async get(key) {
    const { prisma } = await import("@quantself/db");
    const row = await prisma.apiIdempotencyKey.findUnique({
      where: {
        clientId_operation_idempotencyKey: {
          clientId: "todos",
          operation: "capture-archive",
          idempotencyKey: key,
        },
      },
    });
    return (row?.responseBody as Row) ?? null;
  },
  async save(key, result) {
    const { prisma } = await import("@quantself/db");
    const row = await this.get(key);
    await prisma.apiIdempotencyKey.update({
      where: {
        clientId_operation_idempotencyKey: {
          clientId: "todos",
          operation: "capture-archive",
          idempotencyKey: key,
        },
      },
      data: { responseBody: JSON.parse(JSON.stringify({ ...row, result })) },
    });
  },
  async redact(key) {
    const { prisma } = await import("@quantself/db");
    await prisma.apiIdempotencyKey.update({
      where: {
        clientId_operation_idempotencyKey: {
          clientId: "todos",
          operation: "capture-archive",
          idempotencyKey: key,
        },
      },
      data: { responseBody: { input: null, result: null } },
    });
  },
  async list(prefix) {
    const { prisma } = await import("@quantself/db");
    return (
      await prisma.apiIdempotencyKey.findMany({
        where: {
          clientId: "todos",
          operation: "capture-archive",
          idempotencyKey: { startsWith: prefix },
        },
        orderBy: { createdAt: "asc" },
      })
    ).map((r) => r.responseBody as Row);
  },
};
export const captureAudioSchema = z.object({
  key: z.string(),
  sha256: z.string(),
  size: z.number(),
  mime: z.string(),
  duration: z.number().optional(),
});
export function createCaptureService(
  store: CaptureStore,
  reader: TodoReader,
  audio: AudioStorage = createAudioStorage(),
) {
  async function requireActive(id: string) {
    if (await store.get(`deleted:${id}`))
      throw new TodoWriteError(
        "CAPTURE_DELETED",
        "Source deleted by Owner.",
        409,
      );
  }
  async function read(id: string) {
    const row = await store.get(`capture:${id}`);
    if (!row)
      throw new TodoWriteError("CAPTURE_NOT_FOUND", "Capture not found.", 400);
    const deleted = Boolean(await store.get(`deleted:${id}`));
    const media = await store.get(`audio:${id}`);
    const rows = await store.list(`link:${id}:`);
    return {
      capture: deleted ? null : (row.input as z.infer<typeof captureSchema>),
      deleted,
      audio:
        !deleted && media
          ? (media.input as z.infer<typeof captureAudioSchema>)
          : null,
      links: [
        ...rows.map((row) => {
          const issueSaved = row.result?.outcomes?.issue === "saved";
          const provenanceSaved =
            !row.input.target.number ||
            row.result?.outcomes?.description === "saved";
          return {
            commandId: row.input.target.commandId as string,
            number: (row.result?.todo?.number ?? null) as number | null,
            status: issueSaved && provenanceSaved ? "linked" : "pending",
            result: row.result,
          };
        }),
        ...(await store.list(`jarvis-command:${id}:`)).map((row) => ({
          commandId: row.input.command.commandId as string,
          number: (row.result?.todo?.number ?? null) as number | null,
          status:
            row.result &&
            Object.values(row.result.outcomes).every((v) => v === "saved")
              ? "linked"
              : "pending",
          result: row.result,
        })),
      ],
    };
  }
  return {
    read,
    async upload(
      id: string,
      bytes: Uint8Array,
      mime: string,
      duration?: number,
    ) {
      await requireActive(id);
      await read(id);
      assertOriginalWritesEnabled();
      const existingAudio = await store.get(`audio:${id}`);
      const metadata = {
        key: existingAudio?.input?.key ?? (originalsEnabled() ? `original:todo:${id}` : `${id}.audio`),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        mime,
        ...(duration === undefined ? {} : { duration }),
      };
      await store.reserve(`audio:${id}`, metadata);
      try {
        await audio.put(metadata.key, bytes, mime);
      } finally {
        // A deletion intent wins even if another process was writing the file,
        // including a write that persisted bytes but lost its response.
        if (await store.get(`deleted:${id}`)) await audio.remove(metadata.key);
      }
      await requireActive(id);
      return read(id);
    },
    async mediaResponse(id: string, range?: string | null) {
      await requireActive(id);
      const result = await read(id);
      if (!result.audio) throw new TodoWriteError("AUDIO_NOT_FOUND", "No archived audio.", 400);
      const response = audio.response ? await audio.response(result.audio.key, result.audio, range) : audioBytesResponse(await audio.read(result.audio.key, result.audio), range);
      try { await requireActive(id); } catch (error) { await response.body?.cancel(); throw error; }
      response.headers.set("Content-Type", result.audio.mime);
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      if (response.status === 200) response.headers.set("Content-Length", String(result.audio.size));
      return response;
    },
    async media(id: string) {
      await requireActive(id);
      const result = await read(id);
      if (!result.audio)
        throw new TodoWriteError("AUDIO_NOT_FOUND", "No archived audio.", 400);
      const bytes = await audio.read(result.audio.key, result.audio);
      await requireActive(id);
      return { bytes, metadata: result.audio };
    },
    async delete(id: string) {
      await read(id);
      assertOriginalWritesEnabled();
      // Durable intent immediately denies transcript/media access, even on partial failure.
      await store.reserve(`deleted:${id}`, { id });
      const archived = await store.get(`audio:${id}`);
      if (archived) await audio.remove(archived.input.key);
      if (!store.redact) throw Error("Archive redaction unavailable");
      await store.redact(`capture:${id}`);
      return read(id);
    },
    async create(input: z.infer<typeof captureSubmissionSchema>) {
      const { conversation, ...facts } = captureSubmissionSchema.parse(input);
      const normalized = captureSchema.parse({
        ...facts,
        transcript: conversation
          ? conversation
              .map((message) => `${message.role}: ${message.text}`)
              .join("\n\n")
          : facts.transcript,
      });
      await requireActive(normalized.id);
      await store.reserve(`capture:${normalized.id}`, normalized);
      return read(normalized.id);
    },
    async link(
      client: string,
      id: string,
      input: z.infer<typeof capturePlanSchema>,
    ) {
      capturePlanSchema.parse(input);
      await requireActive(id);
      const { capture } = await read(id);
      if (!capture)
        throw new TodoWriteError(
          "CAPTURE_DELETED",
          "Source deleted by Owner.",
          409,
        );
      // Reserve all interpretations before sending any GitHub command.
      for (const target of input.targets)
        await store.reserve(`link:${id}:${target.commandId}`, {
          client,
          target,
        });
      for (const target of input.targets) {
        const key = `link:${id}:${target.commandId}`;
        const row = await store.get(key);
        if (row?.result && !row.result.retryable) continue;
        const provenance = `Capture ID: ${id}\nSource: ${capture.source}\nCaptured: ${capture.capturedAt}\nOriginal transcript (evidence only):\n${capture.transcript.replaceAll("<", "&lt;")}\n`;
        try {
          if (!reader.write) throw Error("Task writes unavailable");
          const { number, ...create } = target;
          const result = await reader.write(
            client,
            number
              ? {
                  commandId: target.commandId,
                  number,
                  description: { before: "", after: `\n${provenance}` },
                }
              : {
                  ...create,
                  description: `${target.description ?? ""}\n\n${provenance}`,
                },
          );
          await store.save(key, {
            commandId: result.commandId,
            todo: result.todo ? { number: result.todo.number } : null,
            outcomes: result.outcomes,
            message: result.message,
            retryable: result.retryable,
          });
        } catch {
          /* Original plan remains pending; replay uses the same task command. */
        }
      }
      return read(id);
    },
  };
}
