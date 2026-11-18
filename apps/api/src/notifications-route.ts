import { getPublicOrigin } from "@quantself/auth/public-origin";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context, TypedResponse } from "hono";
import type { AccessContext } from "@quantself/auth";
import { prisma } from "@quantself/db";
import { pushConfiguration } from "./notifications";
import type { TodoReader } from "./todos-github";

type Env = { Variables: { accessContext: AccessContext | null } };
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const minutes = z.number().int().min(1).max(10080).nullable();
const zone = z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } });
const subscription = z.object({ endpoint: z.url().max(2048).refine(value => {
  const url = new URL(value);
  // Never allow push enrollment to become an arbitrary server-side HTTP request.
  return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    (url.hostname === "fcm.googleapis.com" || url.hostname === "updates.push.services.mozilla.com" || url.hostname.endsWith(".push.apple.com") || url.hostname.endsWith(".notify.windows.com"));
}), keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}=?$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}==?$/).or(z.string().regex(/^[A-Za-z0-9_-]{22}$/)) }), timeZone: zone });
export function registerNotificationRoutes(app: OpenAPIHono<Env>, reader: TodoReader, db = prisma) {
  function route(method: "get" | "put" | "post", path: string, handler: (c: Context<Env>) => Promise<Response>) {
    const operationId = `${method}Notifications${path.split("/").filter(p => p && p !== "number").join("").replace(/[^a-zA-Z]/g, "")}`;
    const json = { schema: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])), example: {} };
    app.openapi(createRoute({ method, path: `/api/v1/notifications/${path.replace(":number", "{number}")}`, operationId, tags: ["To-Dos"], summary: `${method.toUpperCase()} notification ${path}`,
      description: "Authentication: same-origin Owner ingress only. Required permissions: none. Owner settings are unavailable to API-key clients. Inputs: notification settings, subscription or task alert. Success response: 200 with notification state. Failure responses: 400 invalid input, 401 unauthenticated, 403 forbidden origin or Client, 409 ownership conflict, 503 provider unavailable. Side effects: saves notification delivery preferences on writes. Destructive: no. Retry safety: writes are idempotent; safe to repeat.",
      security: [{ ownerSession: [] }], "x-required-permissions": [], "x-destructive": false,
      ...(path.includes(":number") ? { request: { params: z.object({ number: z.string() }) } } : {}),
      responses: { 200: { description: "Notification state.", content: { "application/json": json } }, 400: { description: "Invalid request.", content: { "application/json": json } }, 401: { description: "Authentication required.", content: { "application/json": json } }, 403: { description: "Forbidden.", content: { "application/json": json } }, 409: { description: "Conflict.", content: { "application/json": json } }, 503: { description: "Unavailable.", content: { "application/json": json } } },
    }), async c => {
      const access = c.get("accessContext");
      if (!access || access.client.kind !== "web") return c.json({ message: "Owner session required." }, 403);
      if (method !== "get") {
        const origin = c.req.header("origin");
        const expected = getPublicOrigin();
        if (!origin || origin !== (expected ? new URL(expected).origin : new URL(c.req.url).origin)) return c.json({ message: "Invalid origin." }, 403);
      }
      c.header("Cache-Control", "no-store");
      const response = await handler(c);
      return response as Response & { [S in 200 | 400 | 401 | 403 | 409 | 503]: TypedResponse<Record<string, string | number | boolean | null>, S, "json"> }[200 | 400 | 401 | 403 | 409 | 503];
    });
  }
  route("get", "settings", async c => {
    const ownerId = c.get("accessContext")!.owner.id;
    const value = await db.notificationSettings.findUnique({ where: { ownerId } });
    return c.json({ enabled: value?.enabled ?? false, morning: value?.morning ?? "09:00", publicKey: pushConfiguration()?.publicKey ?? null });
  });
  route("put", "settings", async c => {
    const parsed = z.object({ enabled: z.boolean(), morning: clock }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: "Invalid notification settings." }, 400);
    const ownerId = c.get("accessContext")!.owner.id;
    const prior = await db.notificationSettings.findUnique({ where: { ownerId } });
    await db.notificationSettings.upsert({ where: { ownerId }, create: { ownerId, ...parsed.data }, update: { ...parsed.data, ...(!prior?.enabled && parsed.data.enabled ? { enabledAt: new Date() } : {}) } });
    return c.json(parsed.data);
  });
  route("post", "devices", async c => {
    const parsed = subscription.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: "Invalid push subscription." }, 400);
    if (!pushConfiguration()) return c.json({ message: "Notifications need server configuration." }, 503);
    const ownerId = c.get("accessContext")!.owner.id;
    const { endpoint, keys, timeZone } = parsed.data;
    const prior = await db.notificationDevice.findUnique({ where: { endpoint } });
    if (prior && prior.ownerId !== ownerId) return c.json({ message: "Subscription belongs to another owner." }, 409);
    await db.notificationDevice.upsert({ where: { endpoint }, create: { ownerId, endpoint, ...keys, timeZone }, update: { ...keys, timeZone } });
    return c.json({ enrolled: true });
  });
  route("get", "tasks/:number", async c => {
    const number = Number(c.req.param("number"));
    if (!Number.isSafeInteger(number) || number < 1) return c.json({ message: "Invalid task." }, 400);
    const row = await db.notificationTask.findUnique({ where: { ownerId_number: { ownerId: c.get("accessContext")!.owner.id, number } } });
    return c.json({ minutes: row ? row.minutes : 10, morning: row?.morning ?? null });
  });
  route("put", "tasks/:number", async c => {
    const number = Number(c.req.param("number"));
    const parsed = z.object({ minutes, morning: clock.nullable().optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!Number.isSafeInteger(number) || number < 1 || !parsed.success) return c.json({ message: "Invalid task alert." }, 400);
    await reader.detail(number);
    const ownerId = c.get("accessContext")!.owner.id;
    await db.notificationTask.upsert({ where: { ownerId_number: { ownerId, number } }, create: { ownerId, number, ...parsed.data }, update: parsed.data });
    return c.json(parsed.data);
  });
}
