import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { registerHabitRoutes } from "./habits-route";
test("API requires explicit habit permissions; denies Jarvis/task keys and cross-origin Owner writes", async () => {
  let permissions = ["todos:read", "todos:write"],
    kind: "api-key" | "web" = "api-key",
    calls = 0;
  const app = new OpenAPIHono<{
    Variables: { accessContext: AccessContext | null };
  }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", {
      owner: { id: "owner", name: "Owner", email: "owner@example.test" },
      client: { id: "client", name: "Jarvis", kind },
      permissions,
    });
    await next();
  });
  registerHabitRoutes(app, {
    read: async () => {
      calls++;
      return {
        date: "2026-11-04",
        today: "2026-11-04",
        projection: null,
        sha: null,
        stale: true,
        error: "Not configured",
        occurrences: [],
      };
    },
    command: async () => {
      calls++;
      return {} as any;
    },
    materialize: async () => ({}) as any,
  });
  expect((await app.request("/api/v1/habits/day")).status).toBe(403);
  expect(calls).toBe(0);
  permissions = ["habits:read"];
  expect((await app.request("/api/v1/habits/day?date=2026-02-30")).status).toBe(
    400,
  );
  expect((await app.request("/api/v1/habits/day")).status).toBe(200);
  expect(calls).toBe(1);
  expect(
    (await app.request("/api/v1/habits/commands", { method: "POST" })).status,
  ).toBe(403);
  permissions = ["habits:write"];
  expect(
    (
      await app.request("/api/v1/habits/slips", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          id: crypto.randomUUID(),
        }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request("/api/v1/habits/slips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          habitId: "pause",
          occurredAt: "2026-02-30T12:00:00Z",
          outcome: "resisted",
        }),
      })
    ).status,
  ).toBe(400);

  kind = "web";
  expect(
    (
      await app.request("/api/v1/habits/commands", {
        method: "POST",
        headers: { origin: "https://foreign.example" },
      })
    ).status,
  ).toBe(403);
});

test("context requires read; review requires write and delegates Halifax date", async () => {
  let permissions: string[] = [],
    calls = 0;
  let expectedDays: 14 | 28 = 28;
  const app = new OpenAPIHono<{
    Variables: { accessContext: AccessContext | null };
  }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", {
      owner: { id: "owner", name: "Owner", email: "owner@example.test" },
      client: { id: "client", name: "Fixture", kind: "api-key" },
      permissions,
    });
    await next();
  });
  registerHabitRoutes(app, undefined, undefined, undefined, {
    context: async (owner, days) => {
      expect(owner).toBe("owner");
      expect(days).toBe(expectedDays);
      calls++;
      return { text: "bundle", unavailable: [] };
    },
    start: async (owner, date) => {
      expect(owner).toBe("owner");
      expect(date).toBe("2026-11-04");
      calls++;
      return { path: "reviews/2026-11-08.md" };
    },
  });
  expect((await app.request("/api/v1/habits/context")).status).toBe(403);
  const start = () =>
    app.request("/api/v1/habits/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-11-04" }),
    });
  expect((await start()).status).toBe(403);
  expect(calls).toBe(0);
  permissions = ["habits:read"];
  expect((await app.request("/api/v1/habits/context")).status).toBe(200);
  expect((await app.request("/api/v1/habits/stats")).status).toBe(404);
  expectedDays = 14;
  expect((await app.request("/api/v1/habits/context?days=14")).status).toBe(200);
  expect((await app.request("/api/v1/habits/context?days=7")).status).toBe(400);
  expect((await start()).status).toBe(403);
  permissions = ["habits:write"];
  expect((await start()).status).toBe(200);
  expect(calls).toBe(3);
});

test("calendar authorizes before reading and bounds inclusive date ranges in one source read", async () => {
  const { parseHabits } = await import("./habits-definition");
  let permissions: string[] = [],
    calls = 0;
  const app = new OpenAPIHono<{
    Variables: { accessContext: AccessContext | null };
  }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", {
      owner: { id: "owner", name: "Owner", email: "owner@example.test" },
      client: { id: "client", name: "Fixture", kind: "api-key" },
      permissions,
    });
    await next();
  });
  registerHabitRoutes(app, undefined, undefined, undefined, undefined, {
    read: async () => {
      calls++;
      return {
        projection:
          parseHabits(`stacks: [{id: routine, name: Routine, anchor: '08:00', durationMinutes: 30}]
habits: [{id: stretch, name: Stretch, stack: routine, status: building}]`),
        sha: "a",
        stale: false,
        error: null,
      };
    },
  });
  const path = "/api/v1/habits/calendar?from=2026-11-01&to=2026-11-21";
  expect((await app.request(path)).status).toBe(403);
  expect(calls).toBe(0);
  permissions = ["habits:read"];
  expect(
    (await app.request("/api/v1/habits/calendar?from=2026-11-01&to=2026-12-02"))
      .status,
  ).toBe(400);
  expect(
    (await app.request("/api/v1/habits/calendar?from=2026-11-21&to=2026-11-01"))
      .status,
  ).toBe(400);
  const response = await app.request(path);
  expect(response.status).toBe(200);
  expect(
    ((await response.json()) as { blocks: unknown[] }).blocks,
  ).toHaveLength(21);
  expect(calls).toBe(1);
});
