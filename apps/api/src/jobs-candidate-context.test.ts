import { expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { Prisma, type PrismaClient } from "@quantself/db/generated/prisma/client";
import { registerJobsRoutes } from "./jobs-route";

type Entry = { markdown: string; version: number };
const path = "/api/v1/jobs/candidate-context";

function fixture() {
  const documents = new Map<string, Entry>();
  const calls = { reads: 0, writes: 0 };
  const owner: AccessContext = {
    owner: { id: "owner-a", email: "", name: "" },
    client: { id: "web", kind: "web", name: "Owner" },
    permissions: ["jobs:read", "jobs:write"],
  };
  const key: AccessContext = { ...owner, client: { id: "key", kind: "api-key", name: "Test client" } };
  const db = { jobCandidateContext: {
    async findUnique({ where }: { where: { ownerId: string } }) {
      calls.reads++;
      return documents.get(where.ownerId) ?? null;
    },
    async create({ data: { ownerId, ...data } }: { data: Entry & { ownerId: string } }) {
      calls.writes++;
      if (documents.has(ownerId)) throw new Prisma.PrismaClientKnownRequestError("Exists", { code: "P2002", clientVersion: "test" });
      documents.set(ownerId, data);
      return data;
    },
    async update({ where, data }: { where: Entry & { ownerId: string }; data: Entry }) {
      calls.writes++;
      if (documents.get(where.ownerId)?.version !== where.version) {
        throw new Prisma.PrismaClientKnownRequestError("Stale", { code: "P2025", clientVersion: "test" });
      }
      documents.set(where.ownerId, data);
      return data;
    },
  } };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  let context: AccessContext | null;
  app.use("*", async (c, next) => { c.set("accessContext", context); await next(); });
  registerJobsRoutes(app, db as unknown as PrismaClient);
  function request(input?: { markdown: string; expectedVersion: number }, access = owner as AccessContext | null, origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost").origin) {
    context = access;
    return app.request(path, input ? {
      method: "PATCH", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(input),
    } : {});
  }
  return { request, owner, key, calls };
}

test("candidate context is owner scoped; only the same-origin Owner can write", async () => {
  const { request, key, owner, calls } = fixture();
  const markdown = "Contact: `{{private.phone}}` and `{{private.email}}`";
  const patch = { markdown, expectedVersion: 0 };
  expect((await request(undefined, null)).status).toBe(401);
  expect((await request(undefined, { ...key, permissions: ["jobs:execute"] })).status).toBe(403);
  expect((await request(patch, key)).status).toBe(403);
  expect((await request(patch, owner, "https://untrusted.example")).status).toBe(403);
  expect(calls).toEqual({ reads: 0, writes: 0 });
  expect(await (await request()).json()).toEqual({ markdown: "", version: 0 });
  expect(await (await request(patch)).json()).toEqual({ markdown, version: 1 });
  const response = await request(undefined, { ...key, permissions: ["jobs:read"] });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ markdown, version: 1 });
  const anotherOwner = { ...key, owner: { ...key.owner, id: "owner-b" } };
  expect(await (await request(undefined, anotherOwner)).json()).toEqual({ markdown: "", version: 0 });
  expect(calls).toEqual({ reads: 3, writes: 1 });
});

test("a stale write cannot overwrite candidate context or recreate version zero", async () => {
  const { request, calls } = fixture();
  const first = { markdown: "Built web tools", expectedVersion: 0 };
  expect((await request(first)).status).toBe(200);
  expect((await request(first)).status).toBe(409);
  const responses = await Promise.all([
    request({ markdown: "First edit", expectedVersion: 1 }),
    request({ markdown: "Second edit", expectedVersion: 1 }),
  ]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  const accepted = await responses.find(response => response.ok)!.json();
  expect(await (await request()).json()).toEqual(accepted);
  expect(calls).toEqual({ reads: 1, writes: 4 });
});

test("obvious unmasked contact values and oversized text are rejected before storage", async () => {
  const { request, calls } = fixture();
  for (const markdown of ["Email: sample@example.test", "Phone: +1 (902) 555-0100", "a".repeat(50_001)]) {
    expect((await request({ markdown, expectedVersion: 0 })).status).toBe(400);
  }
  expect(calls).toEqual({ reads: 0, writes: 0 });
});
