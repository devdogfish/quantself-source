import { test, expect } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { prisma } from "@quantself/db";
import { registerNotificationRoutes } from "./notifications-route";
import { notificationSnapshot } from "./notifications";
import { planAlerts } from "./notifications-plan";
import type { Todo, TodoReader } from "./todos-github";

test("notification controls reject API keys and cross-origin mutations before accessing storage", async () => {
  for (const kind of ["web", "api-key"] as const) {
    const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
    app.use("*", async (c,next) => { c.set("accessContext", { owner: { id: "owner", email: "test@example.com", name: "Test" }, client: { id: "client", kind, name: "Test" }, permissions: [] }); await next(); });
    const reader = {} as TodoReader;
    registerNotificationRoutes(app,reader,{} as typeof prisma);
    const response = await app.request("/api/v1/notifications/settings", { method: "PUT", headers: { origin: "https://attacker.invalid", "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, morning: "09:00" }) });
    expect(response.status).toBe(403);
    if (kind === "api-key") expect((await app.request("/api/v1/notifications/settings")).status).toBe(403);
  }
});
test("notification delivery rejects missing or malformed freshness evidence", async () => {
  for (const readAt of [null, "not-a-date", new Date(Date.now()-120000).toISOString()]) {
    const reader = { list: async () => [], freshness: async () => ({ generation: 1, stale: false, readAt }) } as unknown as TodoReader;
    await expect(notificationSnapshot(reader)).rejects.toThrow("fresh task data");
  }
});
