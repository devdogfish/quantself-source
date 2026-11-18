import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import { getPublicOrigin } from "@quantself/auth/public-origin";
import type { Prisma, PrismaClient } from "@quantself/db/generated/prisma/client";
import { registerJobsRoutes } from "./jobs-route";

test("only the Owner can fill a missing brief on the current review revision", async () => {
  const origin = getPublicOrigin() ?? "https://jobs.example.test";
  const id = randomUUID();
  const owner: AccessContext = {
    owner: { id: "owner", email: "", name: "" },
    client: { id: "owner-web", kind: "web", name: "Owner" },
    permissions: ["jobs:write"],
  };
  const brief = {
    doing: "Maintain the product catalog.", remote: "confirmed",
    companySize: { people: null, label: "Company size not stated" },
    automatable: "medium", humanContact: { level: "low", note: "Written updates" },
    meetings: { level: "rare", note: "Schedule not stated" },
    pay: { hourlyCad: null, original: null, converted: false },
  };
  const row = { id, ownerId: owner.owner.id, revision: 7, status: "review", summary: "Saved résumé", brief: null as unknown };
  const commands = new Map<string, Record<string, unknown>>();
  let writes = 0;
  const tx = {
    apiIdempotencyKey: {
      findUnique: async ({ where }: { where: Prisma.ApiIdempotencyKeyWhereUniqueInput }) =>
        commands.get(where.clientId_operation_idempotencyKey!.idempotencyKey),
      create: async ({ data }: { data: Record<string, unknown> }) => commands.set(String(data.idempotencyKey), data),
      update: async ({ where, data }: { where: Prisma.ApiIdempotencyKeyWhereUniqueInput; data: Record<string, unknown> }) => {
        const key = where.clientId_operation_idempotencyKey!.idempotencyKey;
        commands.set(key, { ...commands.get(key), ...data });
      },
    },
    jobApplication: {
      updateMany: async ({ where, data }: Prisma.JobApplicationUpdateManyArgs) => {
        if (row.ownerId !== where?.ownerId || row.id !== where?.id || row.revision !== where?.revision ||
          row.status !== where?.status || row.brief !== null) return { count: 0 };
        Object.assign(row, data);
        writes++;
        return { count: 1 };
      },
      findUnique: async ({ where }: Prisma.JobApplicationFindUniqueArgs) =>
        where.ownerId_id?.id === row.id && where.ownerId_id.ownerId === row.ownerId ? { id } : null,
    },
  };
  const db = { $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx) };
  const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
  let context = owner;
  app.use("/api/v1/jobs/*", async (c, next) => { c.set("accessContext", context); await next(); });
  registerJobsRoutes(app, db as unknown as PrismaClient);
  const write = (expectedRevision: number, key = randomUUID()) => app.request(`${origin}/api/v1/jobs/applications/${id}/brief`, {
    method: "PATCH",
    headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ expectedRevision, brief }),
  });

  context = { ...owner, client: { ...owner.client, kind: "api-key" } };
  expect((await write(7)).status).toBe(403);
  context = { ...owner, owner: { ...owner.owner, id: "other-owner" } };
  expect((await write(7)).status).toBe(404);
  context = owner;
  expect((await write(6)).status).toBe(409);
  expect(row.brief).toBeNull();
  const key = randomUUID();
  const result = await write(7, key);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ id });
  expect((await write(7, key)).status).toBe(200);
  expect((await write(7)).status).toBe(409);
  expect(writes).toBe(1);
  expect(row).toMatchObject({ brief, revision: 7, status: "review", summary: "Saved résumé" });
});

test.skipIf(process.env.QUANTSELF_JOBS_BRIEF_FIXTURE !== "1")(
  "imported review keeps its saved résumé, PDF identity and work across competing brief saves and replay",
  async () => {
    const database = new URL(process.env.DATABASE_URL!);
    expect(database.hostname).toBe("127.0.0.1");
    expect(database.pathname).toBe("/jobs_brief_fixture");
    const { prisma } = await import("@quantself/db");
    const { parseResumeDocument } = await import("../../../scripts/jobs/resume-document");
    const origin = getPublicOrigin() ?? "http://localhost:3000";
    const ownerId = "synthetic-jobs-brief";
    const owner: AccessContext = {
      owner: { id: ownerId, email: "jobs@example.test", name: "Fixture Owner" },
      client: { id: "job-brief-fixture-owner", kind: "web", name: "Owner" },
      permissions: ["jobs:read", "jobs:write"],
    };
    const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
    app.use("*", async (c, next) => { c.set("accessContext", owner); await next(); });
    registerJobsRoutes(app, prisma);
    const write = (path: string, body: unknown, key = randomUUID(), method = "PATCH") => app.request(origin + "/api/v1/jobs" + path, {
      method, headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
    });
    const read = (path: string) => app.request(origin + "/api/v1/jobs" + path);
    const resume = parseResumeDocument("# {{fullName}}\n\n{{contact}}\n\n## Summary\n\n- Maintain the catalog.\n");
    const sourceUrl = "https://boards.greenhouse.io/fixture/jobs/63960";
    const brief = {
      doing: "Maintain the product catalog.", remote: "confirmed",
      companySize: { people: null, label: "Company size not stated" }, automatable: "medium",
      humanContact: { level: "low", note: "Written updates" }, meetings: { level: "rare", note: "Rare" },
      pay: { hourlyCad: null, original: null, converted: false },
    };
    try {
      const imported = await write("/applications/import", { applications: [{
        company: "Fixture", role: "Catalog Editor", sourceUrl, track: "web",
        postingText: "Maintain the catalog.", resumeMarkdown: resume.markdown,
      }] }, undefined, "POST");
      expect(imported.status).toBe(200);
      expect(await imported.json()).toEqual({ imported: 1, duplicates: 0 });
      const { id } = await prisma.jobApplication.findFirstOrThrow({ where: { ownerId, sourceUrl }, select: { id: true } });
      const where = { ownerId_id: { ownerId, id } };
      const revision = 1;
      const revisionKey = { ownerId, applicationId: id, revision };
      // Restore the legacy missing-brief state on the imported draft without running a model.
      await prisma.$transaction([
        prisma.jobApplication.update({ where, data: {
          revision, status: "review", summary: resume.summary, resumeMarkdown: resume.markdown, hasResumeMarkdown: true,
        } }),
        prisma.jobRevision.create({ data: { ...revisionKey, summaryMarkdown: resume.summary, resumeMarkdown: resume.markdown,
          pdfReference: "synthetic-pdf-reference", pdfSha256: "a".repeat(64) } }),
        prisma.jobWorkItem.updateMany({ where: { ownerId, applicationId: id, kind: "enrich" }, data: { state: "done" } }),
      ]);
      const applicationPath = "/applications/" + id;
      const path = applicationPath + "/brief";
      const readRecord = () => prisma.jobApplication.findUniqueOrThrow({ where, include: { revisions: true, workItems: true, events: true } });
      const before = await readRecord();
      const commands = [brief, { ...brief, doing: "The competing brief" }].map(brief => ({
        key: randomUUID(), input: { expectedRevision: revision, brief },
      }));
      const responses = await Promise.all(commands.map(({ key, input }) => write(path, input, key)));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const winner = commands[responses.findIndex(response => response.ok)];
      // Discard the first successful response and replay its exact command.
      const replay = await write(path, winner.input, winner.key);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ id });
      const after = await readRecord();
      expect(after).toEqual({ ...before, brief: winner.input.brief, updatedAt: after.updatedAt });
      const detail = await read(applicationPath);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ application: {
        revision, brief: winner.input.brief, summaryMarkdown: resume.summary, resumeMarkdown: resume.markdown,
      } });

      const edit = await write(applicationPath, { expectedRevision: revision, summaryMarkdown: "- Maintain the synthetic storefront." });
      expect(edit.status).toBe(200);
      expect(await edit.json()).toMatchObject({ application: { revision: 2, brief: winner.input.brief } });
      expect((await write(path, winner.input, winner.key)).status).toBe(200);
      expect((await readRecord()).revision).toBe(2);
    } finally {
      await prisma.$disconnect();
    }
  },
);
