import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeHeader } from "../../../scripts/jobs/resume-document";
import { JobsError } from "./jobs-error";
import { intakeHeldJobsDraft } from "./jobs-owner-write";
import { jobsWorkClaimOutput, jobsWorkerPath } from "./jobs-work-contract";
import { claimHeldJobsEnrichment, withJobsWorkTransaction } from "./jobs-work-service";

const workerSecret = "synthetic-pilot-lease-worker-token";
const importPath = "/api/v1/jobs/applications/import";
const claimPath = jobsWorkerPath + "/work/claim";
const heldPath = "/__fixture/pilot/intake";
const exactPath = "/__fixture/pilot/claim";
const startedAt = new Date("2040-01-01T00:00:00Z");
const template = `${resumeHeader}## Summary\n\n- Edited product pages\n\n## Experience\n\n- Maintained product catalogs\n`;
type HeldIntakeResult = Awaited<ReturnType<typeof intakeHeldJobsDraft>>;

test.skipIf(process.env.QUANTSELF_JOBS_PILOT_LEASE_FIXTURE !== "1")(
  "durable pilot holds isolate exact claims, stale work, expired leases and replayed retries from ordinary Jobs",
  async () => {
    const database = new URL(process.env.DATABASE_URL ?? "");
    if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1" || !database.port || database.pathname !== "/jobs_pilot_lease_fixture") {
      throw new Error("Use a disposable Docker jobs_pilot_lease_fixture database.");
    }
    const [{ prisma }, { createApp }] = await Promise.all([import("@quantself/db"), import("./app")]);
    const dir = await mkdtemp(join(tmpdir(), "qs-jobs-pilot-lease-"));
    const priorTemplates = process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
    const owner = { id: randomUUID(), name: "Synthetic Owner", email: "pilot-lease@example.test" };
    let now = startedAt;
    const app = createApp({
      emitAccessLog() {},
      resolveAccessContext: async headers => headers.get("x-api-key") === "fixture-import-only" ? {
        owner, client: { kind: "api-key", id: "fixture-pilot-lease-feed", name: "Fixture feed" }, permissions: ["jobs:import-tailored"],
      } : null,
      jobsWorkers: { db: prisma, now: () => now, secrets: () => ({ codex: workerSecret, runner: undefined }) },
    });
    app.onError(error => { throw error; });
    const requests: string[] = [];
    const primaryLeased = Promise.withResolvers<void>();
    const finishPrimary = Promise.withResolvers<void>();
    let exactTransactions = 0;
    async function request(path: string, body: unknown, key: string = randomUUID()) {
      requests.push(path);
      return app.request(path, { method: "POST", headers: { "Content-Type": "application/json",
        "X-API-Key": "fixture-import-only", "Idempotency-Key": key, Authorization: `Bearer ${workerSecret}` }, body: JSON.stringify(body) });
    }
    const posting = (id: number) => ({ company: "Synthetic Studio", role: "Editor", track: "web", postingText: `Fixture posting ${id}.`,
      sourceUrl: `https://job-boards.greenhouse.io/synthetic/jobs/${id}`, sourceIdentity: `greenhouse:global:synthetic:${id}` });
    const workSnapshot = () => prisma.jobWorkItem.findMany({ where: { ownerId: owner.id }, orderBy: { applicationId: "asc" } });
    async function claim(path: string, input: unknown) {
      const response = await request(path, input);
      expect(response.status).toBe(200);
      return jobsWorkClaimOutput.parse(await response.json()).work;
    }
    const ordinaryClaim = () => claim(claimPath, { workerId: "ordinary", kinds: ["enrich"] });

    const approvedPostings = [
      ["held-intake", 103], ["held-duplicate", 103], ["held-existing", 101], ["held-stale", 104], ["held-retry", 106],
    ] as const;
    const approvals = new Map<string, Parameters<typeof intakeHeldJobsDraft>[1]>(approvedPostings.map(([id, postingId]) =>
      [id, { id, ownerId: owner.id, sourceIdentity: posting(postingId).sourceIdentity }]));
    app.post(heldPath, async c => {
      const { applications, ownerId = owner.id } = await c.req.json<{ applications: unknown[]; ownerId?: string }>();
      const approval = approvals.get(c.req.header("Idempotency-Key") ?? "");
      if (!approval || !Array.isArray(applications) || applications.length !== 1) return c.json({ error: "Invalid fixture intake" }, 400);
      try {
        return c.json(await intakeHeldJobsDraft(prisma, approval, ownerId, applications[0], now));
      } catch (error) {
        if (error instanceof JobsError) return c.json({ error: error.message }, error.status);
        throw error;
      }
    });

    app.post(exactPath, async c => {
      const { applicationId, revision, workerId } = await c.req.json<{ applicationId: string; revision: number; workerId: string }>();
      const result = await withJobsWorkTransaction(prisma, async tx => {
        exactTransactions++;
        const claim = await claimHeldJobsEnrichment(tx, { ownerId: owner.id, role: "codex" }, { applicationId, revision, workerId }, now);
        if (workerId === "pilot" && claim.work) {
          primaryLeased.resolve();
          await finishPrimary.promise;
        }
        return claim;
      });
      return c.json(result);
    });

    try {
      process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = dir;
      await writeFile(join(dir, "web.md"), template);
      await prisma.user.create({ data: owner });
      await prisma.authOwner.create({ data: { id: "singleton", userId: owner.id } });
      const { sourceIdentity: _sourceIdentity, ...unbound } = posting(101);
      const ordinary = await request(importPath, { applications: [unbound, posting(102)] });
      expect(ordinary.status).toBe(200);
      expect(await ordinary.json()).toEqual({ imported: 2, duplicates: 0 });
      const intake = { applications: [posting(103)] };
      const entered = await request(heldPath, intake, "held-intake");
      expect(entered.status).toBe(200);
      const original = await entered.json() as HeldIntakeResult;
      expect(original).toMatchObject({ ownerId: owner.id, revision: 0 });
      const { applicationId } = original;
      if (!applicationId) throw new Error("Expected the held draft ID.");
      expect(applicationId).toBeString();
      const before = await workSnapshot();
      const held = before.find(row => row.applicationId === applicationId);
      if (!held) throw new Error("Expected the held draft's work row.");
      const ordinaryBefore = before.filter(row => row.applicationId !== applicationId);
      expect(ordinaryBefore).toHaveLength(2);
      expect(ordinaryBefore.every(row => row.availableAt <= held.availableAt)).toBe(true);
      expect(await prisma.jobApplication.count({ where: { ownerId: owner.id, pilotHeldAt: null } })).toBe(2);
      expect(await prisma.jobApplication.findUnique({ where: { ownerId_id: { ownerId: owner.id, id: applicationId } },
        select: { status: true, pilotHeldAt: true } })).toEqual({ status: "draft", pilotHeldAt: startedAt });
      expect(await prisma.jobProviderPosting.findUnique({ where: {
        ownerId_sourceIdentity: { ownerId: owner.id, sourceIdentity: posting(103).sourceIdentity },
      }, select: { applicationId: true } })).toEqual({ applicationId });
      expect(before.filter(row => row.applicationId === applicationId)).toEqual([held]);
      expect(held).toMatchObject({ kind: "enrich", state: "queued", attempts: 0, revision: 0 });
      expect(await (await request(heldPath, intake, "held-intake")).json()).toEqual(original);
      expect((await request(heldPath, intake, "held-duplicate")).status).toBe(409);
      expect((await request(heldPath, { applications: [posting(101)] }, "held-existing")).status).toBe(409);
      expect(await prisma.jobProviderPosting.count({ where: { ownerId: owner.id, sourceIdentity: posting(101).sourceIdentity } })).toBe(0);
      expect((await request(heldPath, { ...intake, ownerId: randomUUID() }, "held-intake")).status).toBe(403);
      expect((await request(heldPath, { applications: [posting(105)] }, "held-intake")).status).toBe(403);
      expect((await request(heldPath, { applications: [{ ...posting(103), postingText: "Different wording." }] }, "held-intake")).status).toBe(409);
      expect((await request(heldPath, { applications: [{ ...posting(103), sourceUrl: posting(105).sourceUrl }] }, "held-duplicate")).status).toBe(400);
      expect(await workSnapshot()).toEqual(before);

      const staleIntake = await request(heldPath, { applications: [posting(104)] }, "held-stale");
      expect(staleIntake.status).toBe(200);
      const { applicationId: staleId } = await staleIntake.json() as { applicationId: string };
      await prisma.jobApplication.update({ where: { ownerId_id: { ownerId: owner.id, id: staleId } }, data: { revision: 1 } });
      const beforeStale = await workSnapshot();
      expect(await (await request(exactPath, { applicationId: staleId, revision: 0, workerId: "pilot-stale" })).json()).toEqual({ work: null });
      expect(await workSnapshot()).toEqual(beforeStale);

      const exact = { applicationId, revision: held.revision, workerId: "pilot" };
      const started = performance.now();
      const transactionsBeforeRace = exactTransactions;
      const first = claim(exactPath, exact);
      await Promise.race([primaryLeased.promise, first.then(() => { throw new Error("The primary claim skipped the in-transaction lease."); })]);
      const second = claim(exactPath, { ...exact, workerId: "pilot-contender" });
      const ordinaryRequest = ordinaryClaim();
      finishPrimary.resolve();
      const [a, b, normal] = await Promise.all([first, second, ordinaryRequest]);
      const raceMs = Math.round(performance.now() - started);
      const raceTransactionAttempts = exactTransactions - transactionsBeforeRace;
      expect([a, b].filter(Boolean)).toHaveLength(1);
      const pilot = a ?? b;
      if (!pilot) throw new Error("Expected the exact pilot lease.");
      expect(pilot).toMatchObject({ applicationId, id: held.id, revision: 0, kind: "enrich" });
      if (!normal) throw new Error("Expected an ordinary claim alongside the pilot claim.");
      expect(ordinaryBefore.map(row => row.id)).toContain(normal.id);
      expect(raceTransactionAttempts).toBeLessThanOrEqual(6);
      const after = await workSnapshot();
      expect(after.find(row => row.id === held.id)).toMatchObject({ state: "claimed", attempts: 1 });
      expect(after.find(row => row.id === normal.id)).toMatchObject({ state: "claimed", claimedBy: "ordinary", attempts: 1 });
      const untouched = ordinaryBefore.find(row => row.id !== normal.id)!;
      expect(after.find(row => row.id === untouched.id)).toEqual(untouched);
      expect(after.find(row => row.applicationId === staleId)).toEqual(beforeStale.find(row => row.applicationId === staleId));
      expect(await (await request(exactPath, exact)).json()).toEqual({ work: null });
      expect(await workSnapshot()).toEqual(after);

      now = new Date(Math.max(Date.parse(pilot.leaseUntil), Date.parse(normal.leaseUntil)) + 1);
      const expiredReport = await request(`${jobsWorkerPath}/work/${pilot.id}/fail`, {
        leaseToken: pilot.leaseToken, resultId: randomUUID(), code: "rate_limited",
      });
      expect(expiredReport.status).toBe(409);
      expect(await claim(exactPath, exact)).toBeNull();
      const firstOrdinary = await ordinaryClaim();
      const secondOrdinary = await ordinaryClaim();
      expect(new Set([firstOrdinary?.id, secondOrdinary?.id])).toEqual(new Set(ordinaryBefore.map(row => row.id)));
      expect(await ordinaryClaim()).toBeNull();
      const afterExpiry = await workSnapshot();
      expect(afterExpiry.find(row => row.id === normal.id)).toMatchObject({ state: "claimed", attempts: 2 });
      expect(afterExpiry.filter(row => row.applicationId === applicationId || row.applicationId === staleId))
        .toEqual(after.filter(row => row.applicationId === applicationId || row.applicationId === staleId));

      const retryIntake = await request(heldPath, { applications: [posting(106)] }, "held-retry");
      expect(retryIntake.status).toBe(200);
      const { applicationId: retryId } = await retryIntake.json() as HeldIntakeResult;
      if (!retryId) throw new Error("Expected the retry fixture's held draft ID.");
      const retryTarget = { applicationId: retryId, revision: 0, workerId: "pilot-retry" };
      const retryLease = await claim(exactPath, retryTarget);
      if (!retryLease) throw new Error("Expected the retry fixture's initial lease.");
      const retryBody = { leaseToken: retryLease.leaseToken, resultId: randomUUID(), code: "rate_limited" };
      const failPath = `${jobsWorkerPath}/work/${retryLease.id}/fail`;
      expect((await request(failPath, retryBody)).status).toBe(200);
      const queuedRetry = await workSnapshot();
      expect(queuedRetry.find(row => row.id === retryLease.id)).toMatchObject({
        state: "queued", attempts: 1, leaseUntil: null, availableAt: new Date(now.getTime() + 60_000),
      });
      now = new Date(now.getTime() + 60_001);
      const replay = await request(failPath, retryBody);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ accepted: true });
      expect(await prisma.jobEvent.count({ where: { ownerId: owner.id, applicationId: retryLease.applicationId, kind: "work_failed" } })).toBe(1);
      expect(await ordinaryClaim()).toBeNull();
      expect(await claim(exactPath, retryTarget)).toBeNull();
      expect(await workSnapshot()).toEqual(queuedRetry);
      expect(await prisma.jobApplication.count({ where: { ownerId: owner.id, pilotHeldAt: { not: null } } })).toBe(3);
      expect(requests.filter(path => path === heldPath)).toHaveLength(10);
      expect(requests.filter(path => path === exactPath)).toHaveLength(7);
      expect(requests.filter(path => path === claimPath)).toHaveLength(5);
      expect(requests).toHaveLength(26);
      console.info("Durable Jobs pilot hold proof", JSON.stringify({ requests: requests.length, heldRequests: 10, exactRequests: 7,
        ordinaryClaims: 5, expiredOrdinaryReclaimed: true, expiredPilotReclaimed: false, retryReports: 2, acceptedFailureEvents: 1,
        raceTransactionAttempts, exactLeaseWinners: 1, raceMs, providerRequests: 0 }));
    } finally {
      finishPrimary.resolve();
      if (priorTemplates === undefined) delete process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
      else process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = priorTemplates;
      await rm(dir, { recursive: true, force: true });
      await prisma.$disconnect();
    }
  },
  15_000,
);
