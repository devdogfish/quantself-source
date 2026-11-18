import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { registerHabitCatalogRoutes } from "./habits-catalog-route";
import { habitCatalog, HabitCatalogError } from "./habits-catalog";
test("catalog HTTP guards read/write, names actors, validates commands and reports conflicts", async () => {
  let permissions: string[] = [],
    kind: "api-key" | "web" = "api-key",
    calls = 0;
  const app = new OpenAPIHono<{
    Variables: { accessContext: AccessContext | null };
  }>();
  app.use("*", async (c, next) => {
    c.set("accessContext", {
      owner: { id: "owner", name: "Owner", email: "owner@example.test" },
      client: { id: "key", name: "Habit assistant", kind },
      permissions,
    });
    await next();
  });
  const result = {
    revision: 1,
    projection: {
      stacks: [],
      habits: [],
      gate: { window: 14, required: 10 },
      diagnostics: [],
    },
  };
  registerHabitCatalogRoutes(app, {
    ...habitCatalog,
    current: async (owner) => {
      expect(owner).toBe("owner");
      calls++;
      return result;
    },
    history: async () => [],
    apply: async (owner, command, actor) => {
      expect(owner).toBe("owner");
      expect(actor).toBe("Habit assistant");
      calls++;
      throw new HabitCatalogError(409, "Changed");
    },
  });
  expect((await app.request("/api/v1/habits/definitions")).status).toBe(403);
  expect(calls).toBe(0);
  permissions = ["habits:read"];
  const read = await app.request("/api/v1/habits/definitions");
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect(await read.json()).toMatchObject({ revision: 1 });
  const request = () =>
    app.request("/api/v1/habits/definitions/changes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        expectedRevision: 0,
        reason: "Adjust",
        changes: [
          { type: "setGateDefaults", gate: { window: 14, required: 10 } },
        ],
      }),
    });
  expect((await request()).status).toBe(403);
  permissions = ["habits:write"];
  expect((await request()).status).toBe(409);
  kind = "web";
  expect((await request()).status).toBe(403);
  expect(calls).toBe(2);
});
