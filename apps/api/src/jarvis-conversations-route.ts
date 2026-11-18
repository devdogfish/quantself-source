import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import { jsonAuthorizationFailure } from "./authorization-response";

export type JarvisTurn = { role: "user" | "assistant"; text: string };
export type JarvisConversationRow = { rowId: string; captureId: string; createdAt: Date; body: unknown };
export type JarvisConversationCursor = { createdAt: Date; id: string };
export type JarvisConversationStore = {
  /** Jarvis (app + phone) capture archives, descending (createdAt,id), strictly below cursor. */
  list(limit: number, cursor: JarvisConversationCursor | null): Promise<JarvisConversationRow[]>;
  get(captureId: string): Promise<JarvisConversationRow | null>;
  /** One batched lookup of deleted:/audio: keys for the given capture ids. */
  flags(captureIds: string[]): Promise<{ deleted: Set<string>; audio: Set<string> }>;
};

const base = { clientId: "todos", operation: "capture-archive" } as const;
export const jarvisConversationStore: JarvisConversationStore = {
  async list(limit, cursor) {
    const { prisma } = await import("@quantself/db");
    const rows = await prisma.apiIdempotencyKey.findMany({
      where: {
        ...base,
        idempotencyKey: { startsWith: "capture:" },
        OR: [{ responseBody: { path: ["input", "source"], equals: "jarvis" } }, { responseBody: { path: ["input", "source"], equals: "jarvis-phone" } }],
        ...(cursor ? { AND: [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit,
      select: { id: true, idempotencyKey: true, createdAt: true, responseBody: true },
    });
    return rows.map(r => ({ rowId: r.id, captureId: r.idempotencyKey.slice(8), createdAt: r.createdAt, body: r.responseBody }));
  },
  async get(captureId) {
    const { prisma } = await import("@quantself/db");
    const r = await prisma.apiIdempotencyKey.findFirst({ where: { ...base, idempotencyKey: `capture:${captureId}` }, select: { id: true, idempotencyKey: true, createdAt: true, responseBody: true } });
    return r ? { rowId: r.id, captureId, createdAt: r.createdAt, body: r.responseBody } : null;
  },
  async flags(captureIds) {
    const deleted = new Set<string>(); const audio = new Set<string>();
    if (!captureIds.length) return { deleted, audio };
    const { prisma } = await import("@quantself/db");
    const rows = await prisma.apiIdempotencyKey.findMany({
      where: { ...base, idempotencyKey: { in: captureIds.flatMap(id => [`deleted:${id}`, `audio:${id}`]) } },
      select: { idempotencyKey: true },
    });
    for (const { idempotencyKey } of rows) {
      if (idempotencyKey.startsWith("deleted:")) deleted.add(idempotencyKey.slice(8));
      else if (idempotencyKey.startsWith("audio:")) audio.add(idempotencyKey.slice(6));
    }
    return { deleted, audio };
  },
};

/** Inverse of the capture flattening `${role}: ${text}` joined by blank lines; plain text becomes one user turn. */
export function parseTranscriptTurns(transcript: string): JarvisTurn[] {
  const text = transcript.trim();
  if (!text) return [];
  if (!/^(user|assistant): /.test(text)) return [{ role: "user", text }];
  return text.split(/\n\n(?=(?:user|assistant): )/).map(part => {
    const role = part.startsWith("user: ") ? "user" : "assistant";
    return { role, text: part.slice(role.length + 2) } as JarvisTurn;
  });
}

type Parsed = { channel: "app" | "phone"; capturedAt: string; summary: string | null; transcript: string };
function parseBody(row: JarvisConversationRow): Parsed | null {
  const body = row.body as { input?: { source?: unknown; capturedAt?: unknown; transcript?: unknown }; result?: { summary?: unknown } | null } | null;
  const source = body?.input?.source;
  if (source !== "jarvis" && source !== "jarvis-phone") return null;
  return {
    channel: source === "jarvis" ? "app" : "phone",
    capturedAt: typeof body?.input?.capturedAt === "string" ? body.input.capturedAt : row.createdAt.toISOString(),
    summary: typeof body?.result?.summary === "string" && body.result.summary ? body.result.summary : null,
    transcript: typeof body?.input?.transcript === "string" ? body.input.transcript : "",
  };
}

const cursorSchema = z.object({ createdAt: z.string().datetime(), id: z.string().min(1).max(64) }).strict();
function decodeCursor(value: string): JarvisConversationCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error("Invalid cursor");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw Error("Invalid cursor");
  const result = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (new Date(result.createdAt).toISOString() !== result.createdAt) throw Error("Invalid cursor");
  return { id: result.id, createdAt: new Date(result.createdAt) };
}
const encodeCursor = (row: JarvisConversationRow) => Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.rowId })).toString("base64url");

const channel = z.enum(["app", "phone"]);
export function registerJarvisConversationRoutes(
  app: OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>,
  store: JarvisConversationStore = jarvisConversationStore,
) {
  const error = z.object({ code: z.string(), message: z.string() });
  const failure = { description: "Invalid request, denied, not found, or unavailable", content: { "application/json": { schema: error, example: { code: "JARVIS_CONVERSATIONS_UNAVAILABLE", message: "Jarvis conversations unavailable." } } } };
  const item = z.object({ id: z.string().uuid(), channel, capturedAt: z.string(), summary: z.string().nullable(), preview: z.string(), turnCount: z.number().int(), hasAudio: z.boolean() });
  const detail = z.object({ id: z.string().uuid(), channel, capturedAt: z.string(), summary: z.string().nullable(), hasAudio: z.boolean(), turns: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })) });

  app.openapi(createRoute({
    method: "get", path: "/api/v1/jarvis/conversations", operationId: "listJarvisConversations", summary: "List Jarvis voice conversation history (in-app and phone)", security: [{ apiKeyAuth: [] }, { ownerSession: [] }], "x-required-permissions": ["todos:read"], "x-destructive": false, tags: ["To-Dos"],
    description: "Authentication: X-API-Key or trusted Owner ingress. Required permissions: todos:read. Inputs: limit 1–100 (default 25), opaque cursor. Success response: 200 newest first with nextCursor or null; deleted captures are hidden after paging so a page may be short while nextCursor is still set. Items carry summary, first-user-turn preview (max 160 chars), turnCount and hasAudio; no full transcripts. Audio: GET /api/v1/todo-captures/{id}/audio; delete: DELETE /api/v1/todo-captures/{id}. Failure responses: 400 invalid cursor/query, 401, 403, 503. Side effects: none. Destructive: no. Retry safety: safe to repeat.",
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(512).optional() }) },
    responses: { 200: { description: "Conversation history page", content: { "application/json": { example: { conversations: [], nextCursor: null }, schema: z.object({ conversations: z.array(item), nextCursor: z.string().nullable() }) } } }, 400: failure, 401: failure, 403: failure, 503: failure },
  } as const), async c => {
    c.header("Cache-Control", "private, no-store");
    const auth = authorizeAccessContext(c.get("accessContext"), "todos:read");
    if (!auth.ok) return jsonAuthorizationFailure(c, auth.error);
    const { limit, cursor } = c.req.valid("query");
    let after: JarvisConversationCursor | null = null;
    try { if (cursor) after = decodeCursor(cursor); } catch { return c.json({ code: "INVALID_CURSOR", message: "Invalid history cursor." }, 400); }
    try {
      const rows = await store.list(limit + 1, after);
      const page = rows.slice(0, limit);
      const { deleted, audio } = await store.flags(page.map(r => r.captureId));
      const conversations = page.flatMap(row => {
        const parsed = parseBody(row);
        if (!parsed || deleted.has(row.captureId)) return [];
        const turns = parseTranscriptTurns(parsed.transcript);
        const preview = (turns.find(t => t.role === "user") ?? turns[0])?.text ?? "";
        return [{ id: row.captureId, channel: parsed.channel, capturedAt: parsed.capturedAt, summary: parsed.summary, preview: preview.slice(0, 160), turnCount: turns.length, hasAudio: audio.has(row.captureId) }];
      });
      return c.json({ conversations, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null }, 200);
    } catch { return c.json({ code: "JARVIS_CONVERSATIONS_UNAVAILABLE", message: "Jarvis conversations unavailable." }, 503); }
  });

  app.openapi(createRoute({
    method: "get", path: "/api/v1/jarvis/conversations/{id}", operationId: "readJarvisConversation", summary: "Read one Jarvis voice conversation", security: [{ apiKeyAuth: [] }, { ownerSession: [] }], "x-required-permissions": ["todos:read"], "x-destructive": false, tags: ["To-Dos"],
    description: "Authentication: X-API-Key or trusted Owner ingress. Required permissions: todos:read. Inputs: capture id path parameter. Success response: 200 with summary and ordered turns. 404 when missing, deleted, or not a Jarvis capture. Failure responses: 400, 401, 403, 503. Side effects: none. Destructive: no. Retry safety: safe to repeat.",
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: { 200: { description: "Conversation", content: { "application/json": { schema: detail, example: { id: "11111111-1111-4111-8111-000000000000", channel: "app", capturedAt: "2026-10-30T12:00:00.000Z", summary: null, hasAudio: false, turns: [{ role: "user", text: "Hello" }] } } } }, 400: failure, 401: failure, 403: failure, 404: failure, 503: failure },
  } as const), async c => {
    c.header("Cache-Control", "private, no-store");
    const auth = authorizeAccessContext(c.get("accessContext"), "todos:read");
    if (!auth.ok) return jsonAuthorizationFailure(c, auth.error);
    const { id } = c.req.valid("param");
    try {
      const row = await store.get(id);
      const parsed = row && parseBody(row);
      if (!row || !parsed) return c.json({ code: "NOT_FOUND", message: "Conversation not found." }, 404);
      const { deleted, audio } = await store.flags([id]);
      if (deleted.has(id)) return c.json({ code: "NOT_FOUND", message: "Conversation not found." }, 404);
      return c.json({ id, channel: parsed.channel, capturedAt: parsed.capturedAt, summary: parsed.summary, hasAudio: audio.has(id), turns: parseTranscriptTurns(parsed.transcript) }, 200);
    } catch { return c.json({ code: "JARVIS_CONVERSATIONS_UNAVAILABLE", message: "Jarvis conversations unavailable." }, 503); }
  });
}
