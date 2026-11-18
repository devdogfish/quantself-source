import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { createJobsWorkClient } from "../../../scripts/jobs/work-client";
import { jobsRunnerPairingOutput } from "./jobs-owner-contract";
import { registerJobsRoutes } from "./jobs-route";
import { registerJobsWorkerRoutes } from "./jobs-work-route";

const origin = "https://jobs.example.test";
const pairingPath = "/api/v1/jobs/runner/pairing";
const owner: AccessContext = {
  owner: { id: "fixture-owner", email: "", name: "" },
  client: { id: "owner-web", kind: "web", name: "Owner" },
  permissions: ["jobs:read", "jobs:write"],
};
const envRunner = "synthetic-env-runner-credential-0000";
const envCodex = "synthetic-env-codex-credential-0000";
const now = new Date("2026-11-15T12:00:00Z");
type RunnerRow = { ownerId: string; host: string | null; lastHeartbeatAt: Date | null; paused: boolean; pairedKeyHash: string | null };

function fixture() {
  const initial: RunnerRow = { ownerId: owner.owner.id, host: null, lastHeartbeatAt: null, paused: true, pairedKeyHash: null };
  const rows = new Map([[initial.ownerId, initial]]);
  let pairedKeyLookups = 0;
  const db = {
    authOwner: { findUnique: async () => ({ userId: owner.owner.id }) },
    jobRunner: {
      async upsert({ where, create, update }: { where: { ownerId: string }; create: Partial<RunnerRow>; update: Partial<RunnerRow> }) {
        const row = rows.get(where.ownerId);
        const saved = row ? { ...row, ...update } : { ...initial, ownerId: where.ownerId, paused: false, ...create };
        rows.set(where.ownerId, saved);
        return saved;
      },
      async findUnique({ where }: { where: { ownerId: string; pairedKeyHash?: string } }) {
        if (where.pairedKeyHash !== undefined) pairedKeyLookups++;
        const row = rows.get(where.ownerId);
        return row && (where.pairedKeyHash === undefined || where.pairedKeyHash === row.pairedKeyHash) ? row : null;
      },
    },
    $transaction<T>(operation: (tx: unknown) => Promise<T>) { return operation(db); },
  };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  let context: AccessContext | null = null;
  app.use("/api/v1/jobs/*", async (c, next) => { c.set("accessContext", context); await next(); });
  registerJobsRoutes(app, db as unknown as PrismaClient);
  registerJobsWorkerRoutes(app, { db: db as unknown as PrismaClient, now: () => now, secrets: () => ({ runner: envRunner, codex: envCodex }) });

  const validOrigin = new URL(process.env.BETTER_AUTH_URL ?? origin).origin;
  function pair(access: AccessContext | null = owner, requestOrigin = validOrigin) {
    context = access;
    return app.request(origin + pairingPath, {
      method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json" }, body: "{}",
    });
  }
  const worker = (secret: string) => createJobsWorkClient({
    baseUrl: origin, secret,
    fetchImpl: ((input, init) => Promise.resolve(app.request(input instanceof Request
      ? new Request(input, init) : new Request(String(input), init)))) as typeof fetch,
  });
  return { pair, worker, runner: () => rows.get(owner.owner.id)!, pairedKeyLookups: () => pairedKeyLookups };
}

test("only the same-origin Owner with Jobs write permission can issue a key", async () => {
  const { pair, runner } = fixture();
  const apiKey = { ...owner, client: { ...owner.client, kind: "api-key" as const } };
  expect((await pair(null)).status).toBe(401);
  expect((await pair(apiKey)).status).toBe(403);
  expect((await pair({ ...owner, permissions: ["jobs:read"] })).status).toBe(403);
  expect((await pair(owner, "https://elsewhere.example.test")).status).toBe(403);
  expect(runner().pairedKeyHash).toBeNull();
});

test("a paired Mac connects through the private runner client and respects pause and worker roles", async () => {
  const { pair, worker, runner, pairedKeyLookups } = fixture();
  const response = await pair();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { key } = jobsRunnerPairingOutput.parse(await response.json());
  expect(runner().pairedKeyHash).toBe(createHash("sha256").update(key).digest("hex"));

  await worker(key).heartbeat("fixture Mac");
  expect(pairedKeyLookups()).toBe(1);
  expect(runner()).toMatchObject({ host: "fixture Mac", lastHeartbeatAt: now, paused: true });
  expect(await worker(key).claim({ workerId: "fixture-mac", kinds: ["submit"] })).toBeNull();
  await expect(worker(key).claim({ workerId: "fixture-mac", kinds: ["tailor"] })).rejects.toThrow("jobs_work_api_403");
  await expect(worker(envCodex).heartbeat("fixture Codex")).rejects.toThrow("jobs_work_api_403");

  const replacement = jobsRunnerPairingOutput.parse(await (await pair()).json()).key;
  await expect(worker(key).heartbeat("replaced Mac")).rejects.toThrow("jobs_work_api_401");
  await worker(replacement).heartbeat("replacement Mac");
  const previousLookups = pairedKeyLookups();
  await worker(envRunner).heartbeat("environment Mac");
  expect(pairedKeyLookups()).toBe(previousLookups);
  expect(runner()).toMatchObject({ host: "environment Mac", paused: true });
});
