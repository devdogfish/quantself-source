import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { HabitCatalogError, type HabitChange } from "./habits-catalog";
import { registerJarvisHabitRoutes } from "./jarvis-habits-route";

const url = "/api/v1/habits/system";
const projection = { habits: [], stacks: [], gate: { window: 14, required: 10 }, diagnostics: [] };

test("Jarvis catalog read is scoped and bounds history to five revisions through the projection revision", async () => {
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  let access: AccessContext | null = null;
  app.use("*", async (c, next) => { c.set("accessContext", access); await next(); });
  registerJarvisHabitRoutes(app, {
    async current(ownerId) {
      expect(ownerId).toBe("owner");
      return { projection, revision: 8 };
    },
    async history(ownerId, options) {
      expect(ownerId).toBe("owner");
      expect(options).toEqual({ before: 9, limit: 5 });
      return [];
    },
    async apply() { throw Error("Unexpected write."); },
  });
  expect((await app.request(url)).status).toBe(401);
  access = {
    owner: { id: "owner", email: "owner@example.test", name: "Owner" },
    client: { id: "key", name: "Jarvis", kind: "api-key" },
    permissions: [],
  };
  expect((await app.request(url)).status).toBe(403);
  access.permissions.push("habits:read");
  const response = await app.request(url);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ projection, revision: 8, history: [] });
});

test("Jarvis catalog write validates changes, passes the key name and propagates conflicts", async () => {
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  const access: AccessContext = {
    owner: { id: "owner", email: "owner@example.test", name: "Owner" },
    client: { id: "key", name: "Jarvis", kind: "api-key" },
    permissions: ["habits:read"],
  };
  app.use("*", async (c, next) => { c.set("accessContext", access); await next(); });
  const command = { commandId: crypto.randomUUID(), reason: "Owner requested a break", expectedRevision: 8 };
  const changes: HabitChange[] = [{ type: "setStatus", habitId: "movement", status: "paused" }];
  let applies = 0;
  registerJarvisHabitRoutes(app, {
    async current() { throw Error("Unexpected read."); },
    async history() { throw Error("Unexpected read."); },
    async apply(ownerId, input, actor) {
      expect(ownerId).toBe("owner");
      expect(input).toEqual({ ...command, changes });
      expect(actor).toBe("Jarvis");
      applies++;
      if (applies > 1) throw new HabitCatalogError(409, "Catalog changed.");
      return { projection, revision: 9 };
    },
  });
  const send = (changesJson: string) => app.request(`${url}/changes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...command, changesJson }),
  });
  const changesJson = JSON.stringify(changes);
  expect((await send(changesJson)).status).toBe(403);
  access.permissions.push("habits:write");
  expect((await send("[")).status).toBe(400);
  expect((await send(JSON.stringify([{ type: "invalid" }]))).status).toBe(400);
  expect(applies).toBe(0);
  const response = await send(changesJson);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ projection, revision: 9 });
  expect((await send(changesJson)).status).toBe(409);
});
