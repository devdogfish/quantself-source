import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AccessContext } from "@quantself/auth";
import type { Prisma } from "@quantself/db/generated/prisma/client";
import { resumeHeader } from "../../../scripts/jobs/resume-document";

const path = "/api/v1/jobs/pilot/permits";
const origin = "http://localhost";
const identity = (id: string) => `greenhouse:global:pilot-fixture:${id}`;
const posting = (id: string) => ({
  sourceIdentity: identity(id), sourceUrl: `https://boards.greenhouse.io/pilot-fixture/jobs/${id}`,
  company: "Fixture Studio", role: "Editor", track: "web", postingText: "Publish product pages.",
});
const template = `${resumeHeader}## Summary\n\n- Edited product pages\n\n## Experience\n\n- Maintained catalogs\n`;

test.skipIf(process.env.QUANTSELF_JOBS_PILOT_PERMIT_FIXTURE !== "1")(
  "Owner permit and authenticated held intake commit a single replayable draft under concurrent access",
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/jobs_pilot_permit_fixture") {
      throw new Error("Use a disposable Docker jobs_pilot_permit_fixture database.");
    }
    const [{ prisma }, { resolveAccessContext }, { registerJobsRoutes, registerJobsPilotIntakeRoute }, { authorizeJobsPilotPermit, bindJobsPilotDraft, revokeJobsPilotPermit },
      { fingerprintIdempotentRequest }, { jobsImportApplicationsInput, jobsPilotPermitOutput, jobsPilotRevocationOutput }] = await Promise.all([
      import("@quantself/db"), import("@quantself/auth"), import("./jobs-route"), import("./jobs-pilot-permit"), import("./idempotency"), import("./jobs-owner-contract"),
    ]);
    const directory = await mkdtemp(join(tmpdir(), "qs-jobs-pilot-permit-"));
    const priorTemplates = process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
    const priorOrigin = process.env.QUANTSELF_PUBLIC_ORIGIN;
    const owner = { id: randomUUID(), name: "Fixture Owner", email: "pilot-owner@example.test" };
    const other = { id: randomUUID(), name: "Other Owner", email: "other-pilot-owner@example.test" };
    const web: AccessContext = { owner, client: { id: "quantself-web", name: "Fixture Web", kind: "web" }, permissions: ["jobs:write"] };
    const api: AccessContext = { owner, client: { id: `fixture-feed:${owner.id}`, name: "Fixture Feed", kind: "api-key" }, permissions: ["jobs:import-tailored"] };
    const app = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
    app.use("*", async (c, next) => {
      const webClient = c.req.header("x-fixture-client");
      if (webClient === "web" || webClient === "other") {
        c.set("accessContext", webClient === "web" ? web : { ...web, owner: other });
        return next();
      }
      c.set("accessContext", await resolveAccessContext(c.req.raw.headers, {
        findExistingOwner: async () => null,
        findOwnerByUserId: async id => {
          const user = [owner, other].find(candidate => candidate.id === id);
          return user ? { userId: id, user } : null;
        },
        verifyApiKey: async key => {
          if (key !== "api" && key !== "cli" && key !== "otherFeed") return null;
          const user = key === "otherFeed" ? other : owner;
          return {
            id: key === "cli" ? "fixture-cli" : `fixture-feed:${user.id}`, name: "Fixture grant", metadata: null,
            referenceId: user.id, permissions: { jobs: [key === "cli" ? "write" : "import-tailored"] },
          };
        },
      }));
      return next();
    });
    registerJobsRoutes(app, prisma);
    const fault = new Error("Fixture acknowledgement lost");
    let failNext: "before" | "after" | undefined;
    const intakeDb = new Proxy(prisma, {
      get(client, property, receiver) {
        if (property !== "$transaction") return Reflect.get(client, property, receiver);
        return async <T>(execute: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) => {
          const fail = failNext;
          failNext = undefined;
          const result = await client.$transaction(async tx => {
            const response = await execute(tx);
            if (fail === "before") throw fault;
            return response;
          }, options);
          if (fail === "after") throw fault;
          return result;
        };
      },
    });
    app.onError((error, c) => {
      if (error !== fault) throw error;
      return c.json({ message: fault.message }, 503);
    });
    registerJobsPilotIntakeRoute(app, intakeDb);
    const send = (route: string, body: unknown, client = "web", key = randomUUID(), requestOrigin = origin) =>
      app.request(route, { method: "POST", headers: {
        origin: requestOrigin, "content-type": "application/json", "idempotency-key": key,
        ...(client === "web" || client === "other" ? { "x-fixture-client": client } : client !== "none" ? { "x-api-key": client } : {}),
      }, body: JSON.stringify(body) });
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const grant = { sourceIdentity: identity("197"), expiresAt };
    const intake = (permitId: string, input = posting("197"), command = randomUUID(), client = "api") =>
      send(path + "/" + permitId + "/intake", { applications: [input] }, client, command);
    const permitWhere = (id: string) => ({ ownerId_id: { ownerId: owner.id, id } });
    // Stand-in for trusted server-side settlement. No caller or HTTP endpoint writes these fields.
    const settleKeep = (permitId: string, input: ReturnType<typeof posting>) => prisma.jobPilotPermit.update({
      where: permitWhere(permitId), data: {
        settledKeepResultId: randomUUID(),
        screenedPostingDigest: fingerprintIdempotentRequest({ posting: jobsImportApplicationsInput.shape.applications.element.parse(input) }),
      }, select: { id: true },
    });
    const issue = async (input = grant, key = randomUUID()) => {
      const response = await send(path, input, "web", key);
      expect(response.status).toBe(200);
      return jobsPilotPermitOutput.parse(await response.json());
    };
    try {
      process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = directory;
      process.env.QUANTSELF_PUBLIC_ORIGIN = origin;
      await writeFile(join(directory, "web.md"), template);
      expect((await send(path, grant, "none")).status).toBe(401);
      expect((await send(path, grant, "api")).status).toBe(403);
      expect((await send(path, grant, "cli")).status).toBe(403);
      expect((await send(path, grant, "web", randomUUID(), "https://foreign.test")).status).toBe(403);
      expect((await send(path, { ...grant, expiresAt: new Date(0).toISOString() })).status).toBe(400);
      expect((await send(path, { ...grant, sourceIdentity: identity("0197") })).status).toBe(400);
      expect((await send(path, { ...grant, ownerId: other.id })).status).toBe(400);
      const closedApp = new OpenAPIHono<{ Variables: { accessContext: AccessContext | null } }>();
      closedApp.use("*", (c, next) => { c.set("accessContext", api); return next(); });
      registerJobsRoutes(closedApp, prisma);
      expect((await closedApp.request(path + "/" + randomUUID() + "/intake", { method: "POST" })).status).toBe(404);

      const key = randomUUID();
      const [permit, concurrent] = await Promise.all([issue(grant, key), issue(grant, key)]);
      expect(concurrent).toEqual(permit);
      expect(await prisma.jobPilotPermit.count({ where: { ownerId: owner.id } })).toBe(1);
      expect((await send(path, { ...grant, sourceIdentity: identity("198") }, "web", key)).status).toBe(409);
      const target = { ownerId: owner.id, permitId: permit.id, sourceIdentity: grant.sourceIdentity };
      const authorize = (candidate: Parameters<typeof authorizeJobsPilotPermit>[1], now?: () => Date) =>
        prisma.$transaction(tx => authorizeJobsPilotPermit(tx, candidate, now));
      expect(await authorize(target)).toEqual({ expiresAt: new Date(expiresAt), allowanceId: null });
      await expect(authorize(target, () => new Date(expiresAt))).rejects.toMatchObject({ status: 409 });
      await expect(authorize({ ...target, ownerId: other.id })).rejects.toMatchObject({ status: 404 });
      await expect(authorize({ ...target, sourceIdentity: identity("198") })).rejects.toMatchObject({ status: 404 });

      const revoke = path + "/" + permit.id + "/revoke";
      expect((await send(revoke, {}, "other")).status).toBe(404);
      expect((await send(revoke, {}, "cli")).status).toBe(403);
      const duplicatePermit = await issue();
      expect((await intake(permit.id, posting("197"), randomUUID(), "none")).status).toBe(401);
      expect((await intake(permit.id, posting("197"), randomUUID(), "invalid")).status).toBe(401);
      expect((await intake(permit.id, posting("197"), randomUUID(), "cli")).status).toBe(403);
      expect((await intake(permit.id, posting("197"), randomUUID(), "web")).status).toBe(403);
      expect((await intake(permit.id, posting("197"), randomUUID(), "otherFeed")).status).toBe(404);
      expect((await intake(permit.id, posting("198"))).status).toBe(404);
      expect((await send(path + "/" + permit.id + "/intake", { applications: [posting("197"), posting("198")] }, "api")).status).toBe(400);
      const command = randomUUID();
      expect((await send(path + "/" + permit.id + "/intake", {
        applications: [posting("197")], settledKeepResultId: randomUUID(),
      }, "api", command)).status).toBe(400);
      expect((await intake(permit.id, posting("197"), command)).status).toBe(409);
      await settleKeep(permit.id, posting("197"));
      expect((await intake(permit.id, { ...posting("197"), postingText: "Different facts." }, command)).status).toBe(409);
      expect((await intake(permit.id, { ...posting("197"), track: "admin" }, command)).status).toBe(409);
      const receiptRows = () => prisma.apiIdempotencyKey.count({ where: {
        clientId: api.client.id, operation: "importScreenedJobsPilotDraft", idempotencyKey: command,
      } });
      failNext = "before";
      expect((await intake(permit.id, posting("197"), command)).status).toBe(503);
      expect(await receiptRows()).toBe(0);
      expect(await prisma.jobPilotPermit.findUnique({ where: permitWhere(permit.id) })).toMatchObject({ applicationId: null, revision: null });
      expect(await prisma.jobApplication.count({ where: { ownerId: owner.id } })).toBe(0);
      expect(await prisma.jobWorkItem.count({ where: { ownerId: owner.id } })).toBe(0);
      failNext = "after";
      expect((await intake(permit.id, posting("197"), command)).status).toBe(503);
      expect(await receiptRows()).toBe(1);
      const committed = await prisma.jobPilotPermit.findUniqueOrThrow({ where: permitWhere(permit.id) });
      if (!committed.applicationId || committed.revision === null) throw new Error("Intake did not atomically bind the permit.");
      const draft = { applicationId: committed.applicationId, revision: committed.revision };
      expect(draft.revision).toBe(0);
      expect(await prisma.jobWorkItem.findMany({
        where: { ownerId: owner.id, applicationId: draft.applicationId }, select: { kind: true, revision: true },
      })).toEqual([{ kind: "enrich", revision: 0 }]);
      expect(await prisma.jobEvent.count({ where: { ownerId: owner.id, applicationId: draft.applicationId, kind: "imported" } })).toBe(1);
      const replay = await intake(permit.id, posting("197"), command);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(draft);
      expect((await intake(permit.id, { ...posting("197"), postingText: "Different facts." }, command)).status).toBe(409);
      expect((await intake(duplicatePermit.id, posting("197"), command)).status).toBe(409);
      expect((await intake(permit.id)).status).toBe(409);
      const bound = { ...target, ...draft };
      const bind = (candidate: typeof bound) => prisma.$transaction(tx => bindJobsPilotDraft(tx, candidate));
      await expect(bind({ ...bound, revision: 1 })).rejects.toMatchObject({ status: 409 });
      await bind(bound);
      await bind(bound);
      await expect(bind({ ...bound, permitId: duplicatePermit.id })).rejects.toMatchObject({ code: "P2002" });
      expect(await authorize(bound)).toEqual({ expiresAt: new Date(expiresAt), allowanceId: null });
      await expect(authorize(target)).rejects.toMatchObject({ status: 409 });
      await prisma.jobApplication.update({ where: { ownerId_id: { ownerId: owner.id, id: draft.applicationId } }, data: { revision: 1 } });
      await expect(authorize(bound)).rejects.toMatchObject({ status: 409 });
      await expect(authorize({ ...bound, revision: 1 })).rejects.toMatchObject({ status: 409 });
      await expect(bind({ ...bound, revision: 1 })).rejects.toMatchObject({ status: 409 });
      await expect(bind({ ...bound, permitId: duplicatePermit.id, revision: 1 })).rejects.toThrow("newly imported held draft");
      expect(await (await intake(permit.id, posting("197"), command)).json()).toEqual(draft);
      expect((await intake(permit.id)).status).toBe(409);

      const [firstRevoke, secondRevoke] = await Promise.all([send(revoke, {}), send(revoke, {})]);
      expect([firstRevoke.status, secondRevoke.status]).toEqual([200, 200]);
      const revocation = jobsPilotRevocationOutput.parse(await firstRevoke.json());
      expect(await secondRevoke.json()).toEqual(revocation);
      expect(await issue(grant, key)).toEqual(permit);
      expect(await prisma.jobPilotPermit.count({ where: { ownerId: owner.id } })).toBe(2);
      expect(await prisma.jobPilotPermit.findUnique({
        where: { ownerId_id: { ownerId: owner.id, id: permit.id } },
      })).toMatchObject({ applicationId: draft.applicationId, revision: 0, revokedAt: new Date(revocation.revokedAt) });
      await expect(authorize(bound)).rejects.toThrow("expired or was revoked");
      await expect(bind(bound)).rejects.toThrow("expired or was revoked");
      expect(await (await intake(permit.id, posting("197"), command)).json()).toEqual(draft);
      expect((await intake(permit.id)).status).toBe(409);
      const held = await prisma.jobApplication.findUniqueOrThrow({ where: { ownerId_id: { ownerId: owner.id, id: draft.applicationId } } });
      expect(held.pilotHeldAt).not.toBeNull();

      const ordinary = { sourceIdentity: identity("198"), expiresAt };
      const pending = await issue(ordinary);
      const importPath = "/api/v1/jobs/applications/import";
      const batch = { applications: [posting("198")] };
      const importKey = randomUUID();
      const first = await send(importPath, batch, "api", importKey);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ imported: 1, duplicates: 0 });
      expect(await (await send(importPath, batch, "api", importKey)).json()).toEqual({ imported: 1, duplicates: 0 });
      expect(await (await send(importPath, batch, "api")).json()).toEqual({ imported: 0, duplicates: 1 });
      expect((await send(path, ordinary)).status).toBe(409);
      const ordinaryTarget = { ...target, permitId: pending.id, sourceIdentity: ordinary.sourceIdentity };
      await expect(authorize(ordinaryTarget)).rejects.toMatchObject({ status: 409 });
      await settleKeep(pending.id, posting("198"));
      expect((await intake(pending.id, posting("198"))).status).toBe(409);
      const normalDraft = await prisma.jobProviderPosting.findUniqueOrThrow({
        where: { ownerId_sourceIdentity: { ownerId: owner.id, sourceIdentity: ordinary.sourceIdentity } },
        select: { application: { select: { id: true, pilotHeldAt: true } } },
      });
      expect(normalDraft.application.pilotHeldAt).toBeNull();
      await expect(bind({ ...ordinaryTarget, applicationId: normalDraft.application.id, revision: 0 })).rejects.toMatchObject({ status: 409 });
      expect(await prisma.jobWorkItem.count({ where: { ownerId: owner.id, kind: "enrich" } })).toBe(2);

      const race = await issue({ sourceIdentity: identity("199"), expiresAt });
      await settleKeep(race.id, posting("199"));
      const revoking = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const revokeTransaction = prisma.$transaction(async tx => {
        await revokeJobsPilotPermit(tx, owner.id, race.id);
        revoking.resolve();
        await release.promise;
      });
      await revoking.promise;
      const authorization = intake(race.id, posting("199"));
      let blocked = false;
      try {
        const deadline = performance.now() + 1_500;
        while (!blocked && performance.now() < deadline) {
          [{ blocked }] = await prisma.$queryRaw<{ blocked: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query LIKE '%FROM "job_pilot_permit"%' AND query LIKE '%FOR UPDATE%'
            ) AS blocked
          `;
          if (!blocked) await Bun.sleep(20);
        }
      } finally {
        release.resolve();
      }
      await revokeTransaction;
      expect(blocked).toBe(true);
      expect((await authorization).status).toBe(409);
      expect(await prisma.jobPilotPermit.findUnique({ where: permitWhere(race.id) })).toMatchObject({ applicationId: null });

      const expired = await issue({ sourceIdentity: identity("200"), expiresAt });
      await settleKeep(expired.id, posting("200"));
      await prisma.jobPilotPermit.update({
        where: permitWhere(expired.id), data: { issuedAt: new Date(0), expiresAt: new Date(1) },
      });
      expect((await intake(expired.id, posting("200"))).status).toBe(409);
      const competing = await issue({ sourceIdentity: identity("201"), expiresAt });
      await settleKeep(competing.id, posting("201"));
      const results = await Promise.all([intake(competing.id, posting("201")), intake(competing.id, posting("201"))]);
      expect(results.map(result => result.status).sort()).toEqual([200, 409]);
      const duplicate = await issue({ sourceIdentity: identity("202"), expiresAt });
      await settleKeep(duplicate.id, posting("202"));
      const duplicateKey = randomUUID();
      const sameKey = await Promise.all([intake(duplicate.id, posting("202"), duplicateKey), intake(duplicate.id, posting("202"), duplicateKey)]);
      expect(sameKey.map(result => result.status)).toEqual([200, 200]);
      expect(await sameKey[0].json()).toEqual(await sameKey[1].json());
      const sharedSource = await issue({ sourceIdentity: identity("203"), expiresAt });
      await settleKeep(sharedSource.id, posting("203"));
      const [heldRace, ordinaryRace] = await Promise.all([
        intake(sharedSource.id, posting("203")), send(importPath, { applications: [posting("203")] }, "api"),
      ]);
      expect(ordinaryRace.status).toBe(200);
      expect([200, 409]).toContain(heldRace.status);
      expect(await ordinaryRace.json()).toEqual(heldRace.ok ? { imported: 0, duplicates: 1 } : { imported: 1, duplicates: 0 });
      const sharedBinding = await prisma.jobPilotPermit.findUniqueOrThrow({ where: permitWhere(sharedSource.id) });
      const sharedDraft = await prisma.jobProviderPosting.findUniqueOrThrow({
        where: { ownerId_sourceIdentity: { ownerId: owner.id, sourceIdentity: sharedSource.sourceIdentity } },
        select: { application: { select: { id: true, pilotHeldAt: true } } },
      });
      expect(sharedBinding.applicationId).toBe(heldRace.ok ? sharedDraft.application.id : null);
      expect(sharedDraft.application.pilotHeldAt !== null).toBe(heldRace.ok);
      expect(await prisma.jobApplication.count({ where: { ownerId: owner.id } })).toBe(5);
      expect(await prisma.jobWorkItem.count({ where: { ownerId: owner.id, kind: "enrich" } })).toBe(5);
    } finally {
      if (priorOrigin !== undefined) process.env.QUANTSELF_PUBLIC_ORIGIN = priorOrigin;
      else delete process.env.QUANTSELF_PUBLIC_ORIGIN;
      if (priorTemplates !== undefined) process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = priorTemplates;
      else delete process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
      await rm(directory, { recursive: true, force: true });
      await prisma.$disconnect();
    }
  },
  15_000,
);
