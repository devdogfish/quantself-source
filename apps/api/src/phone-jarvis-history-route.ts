import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { authorizeAccessContext, type AccessContext } from "@quantself/auth";
import { jsonAuthorizationFailure } from "./authorization-response";

export type PhoneHistoryCursor = { createdAt: Date; id: string };
export type PhoneHistoryRow = {
  id: string; direction: string; createdAt: Date; status: string; captureId: string; archivedAt: Date | null;
};
export type PhoneHistoryStore = {
  /** Select only public metadata; descending (createdAt,id), strictly below cursor. */
  list(limit: number, cursor: PhoneHistoryCursor | null): Promise<PhoneHistoryRow[]>;
};
export const phoneHistoryStore: PhoneHistoryStore = {
  async list(limit, cursor) {
    const { prisma } = await import("@quantself/db");
    return prisma.phoneJarvisCall.findMany({
      where: cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit,
      select: { id: true, direction: true, createdAt: true, status: true, captureId: true, archivedAt: true },
    });
  },
};
const cursorSchema = z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).strict();
function decodeCursor(value: string): PhoneHistoryCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error("Invalid cursor");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw Error("Invalid cursor");
  const result = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (new Date(result.createdAt).toISOString() !== result.createdAt) throw Error("Invalid cursor");
  return { id: result.id, createdAt: new Date(result.createdAt) };
}
const encodeCursor = (row: PhoneHistoryRow) => Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id })).toString("base64url");
export function registerPhoneJarvisHistoryRoutes(
  app: OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>,
  store: PhoneHistoryStore = phoneHistoryStore,
) {
  const error = z.object({ code: z.string(), message: z.string() });
  const failure = { description: "Invalid request, denied, or unavailable", content: { "application/json": { schema: error, example: { code: "PHONE_HISTORY_UNAVAILABLE", message: "Phone history unavailable." } } } };
  app.openapi(createRoute({
    method: "get", path: "/api/v1/phone-jarvis/calls", operationId: "listPhoneJarvisCalls", summary: "List phone Jarvis conversation history", tags: ["To-Dos"],
    security: [{ apiKeyAuth: [] }, { ownerSession: [] }], "x-required-permissions": ["todos:read"], "x-destructive": false,
    description: "Authentication: X-API-Key or trusted Owner ingress. Required permissions: todos:read. Inputs: limit 1–100 (default 25), opaque cursor. Success response: 200 newest calls first, stable createdAt/id ordering, nextCursor or null. Failure responses: 400 invalid cursor/query, 401 unauthenticated, 403 missing permission, 503 unavailable. Side effects: none. Destructive: no. Retry safety: safe repeat; follow nextCursor until null for complete pagination. Newer calls inserted between pages appear on a fresh first page. Metadata links use the existing capture endpoint; deleted evidence remains inaccessible there. No telephone numbers, PIN data, provider credentials, or call payloads are returned.",
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(512).optional() }) },
    responses: { 200: { description: "Bounded conversation history page", content: { "application/json": { example: { calls: [], nextCursor: null }, schema: z.object({ calls: z.array(z.object({ id: z.string().uuid(), direction: z.enum(["inbound", "outbound"]), createdAt: z.string().datetime(), status: z.string(), captureId: z.string().uuid(), archivedAt: z.string().datetime().nullable(), captureUrl: z.string() })), nextCursor: z.string().nullable() }) } } }, 400: failure, 401: failure, 403: failure, 503: failure },
  } as const), async c => {
    c.header("Cache-Control", "private, no-store");
    const auth = authorizeAccessContext(c.get("accessContext"), "todos:read");
    if (!auth.ok) return jsonAuthorizationFailure(c, auth.error);
    const { limit, cursor } = c.req.valid("query");
    let after: PhoneHistoryCursor | null = null;
    try { if (cursor) after = decodeCursor(cursor); } catch { return c.json({ code: "INVALID_CURSOR", message: "Invalid history cursor." }, 400); }
    try {
      const rows = await store.list(limit + 1, after);
      const page = rows.slice(0, limit);
      // Explicit projection also protects injectable adapters from accidental leaks.
      const calls = page.map(row => ({ id: row.id, direction: row.direction as "inbound" | "outbound", createdAt: row.createdAt.toISOString(), status: row.status, captureId: row.captureId, archivedAt: row.archivedAt?.toISOString() ?? null, captureUrl: `/api/v1/todo-captures/${row.captureId}` }));
      return c.json({ calls, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null }, 200);
    } catch { return c.json({ code: "PHONE_HISTORY_UNAVAILABLE", message: "Phone history unavailable." }, 503); }
  });
}
