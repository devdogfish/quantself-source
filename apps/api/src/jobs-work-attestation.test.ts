import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Prisma } from "@quantself/db/generated/prisma/client";
import { resolveJobSubmission } from "./jobs-owner-write";
import { claimJobsWork, failJobsWork, recordJobsSubmissionEvent } from "./jobs-work-service";

function submission({
  expired = false, attempts = 3, startChannel, sesPreflight = false,
}: { expired?: boolean; attempts?: number; startChannel?: "ses" | "browser"; sesPreflight?: boolean } = {}) {
  const now = new Date("2026-11-14T19:00:00Z");
  const ownerId = "fixture-owner", applicationId = randomUUID(), workId = randomUUID();
  const resultId = randomUUID();
  const sha256 = "a".repeat(64);
  const leaseTokenHash = "b".repeat(64);
  const revision = 2;
  const expiredLease = new Date(now.getTime() - 1);
  const application = {
    ownerId, id: applicationId, status: expired ? "submitting" : "needs_attention",
    issueCode: expired ? null : "submission_uncertain", submitLeaseUntil: expired ? expiredLease : null,
    revision, approvedRevision: revision, approvedPreviewDigest: sha256, updatedAt: now,
    resumeTrack: "web", company: "Fixture", role: "Editor", sourceUrl: "https://example.test/job",
    applicationAddress: "luigi.h7mq@luigigirke.com",
  };
  const work = {
    ownerId, applicationId, id: workId, kind: "submit", state: expired ? "claimed" : "failed",
    failureCode: expired ? null : "submission_uncertain", attempts, revision, resultId, application,
    leaseUntil: expired ? expiredLease : null, leaseTokenHash, payload: {},
  };
  const events: unknown[] = [];
  const tx = {
    jobApplication: {
      findUnique: async () => application,
      updateMany: async ({ data }: { data: object }) => { Object.assign(application, data); return { count: 1 }; },
      update: async ({ data }: { data: { privatePause?: unknown } }) =>
        Object.assign(application, data, data.privatePause === Prisma.DbNull ? { privatePause: null } : {}),
    },
    jobRevision: { findUnique: async () => ({ pdfReference: "fixture-pdf", pdfSha256: sha256 }) },
    jobRunner: { findUnique: async () => null },
    jobWorkItem: {
      findUnique: async () => work,
      findFirst: async () => work.state === "queued" ? work : null,
      upsert: async ({ update }: { update: object }) => Object.assign(work, update),
      update: async ({ data }: { data: object }) => {
        const { attempts, ...fields } = data as { attempts?: { increment: number } };
        if (attempts) work.attempts += attempts.increment;
        return Object.assign(work, fields);
      },
    },
    jobEvent: {
      findFirst: async ({ where }: { where: { kind: string; AND: { payload: { path: string[]; equals: unknown } }[] } }) => {
        if (!where.AND.some(({ payload }) => payload.path[0] === "attempt" && payload.equals === attempts)) return null;
        if (where.kind === "submit_started" && startChannel) return { payload: startChannel === "ses" ? { channel: "ses" } : {} };
        if (where.kind === "submission_step" && sesPreflight) return { payload: { step: "runner_claimed", state: "done", channel: "ses" } };
        return null;
      },
      create: async ({ data }: { data: unknown }) => { events.push(data); },
    },
  } as unknown as Prisma.TransactionClient;
  return { now, ownerId, applicationId, work, application, resultId, sha256, leaseTokenHash, events, tx };
}

async function resolveAndClaim(fixture: ReturnType<typeof submission>, supportsOwnerAttestation = true) {
  const { tx, ownerId, applicationId, now } = fixture;
  await resolveJobSubmission(tx, ownerId, applicationId, { action: "mark_not_sent", expectedUpdatedAt: now.toISOString() }, now);
  const input = { workerId: "fixture", kinds: ["submit" as const], supportsOwnerAttestation };
  return (await claimJobsWork(tx, { ownerId, role: "runner" }, input, now)).work;
}

test("Owner resolution keeps the original approval and lease through pre-start retries until a durable start", async () => {
  const fixture = submission({ startChannel: "ses" });
  const first = await resolveAndClaim(fixture);
  const ownerAttestation = {
    previousWorkId: fixture.work.id, previousAttempt: 3, previousResultId: fixture.resultId,
    approvedRevision: 2, sha256: fixture.sha256, previousLeaseTokenHash: fixture.leaseTokenHash, resolvedAt: fixture.now.toISOString(),
  };
  expect(first).toMatchObject({ id: fixture.work.id, attempt: 4, ownerAttestation });
  expect(fixture.events).toEqual([expect.objectContaining({
    kind: "submission_resolved", payload: { action: "mark_not_sent", status: "queued", ownerAttestation },
  })]);
  const { tx, work, application, ownerId, applicationId, now } = fixture;
  const current = work as unknown as Parameters<typeof failJobsWork>[1];
  const claimAgain = () => claimJobsWork(tx, { ownerId, role: "runner" },
    { workerId: "fixture", kinds: ["submit"], supportsOwnerAttestation: true }, now);
  await failJobsWork(tx, current, { leaseToken: "fixture-lease-token", resultId: randomUUID(), code: "runner_unavailable" }, now);
  await resolveJobSubmission(tx, ownerId, applicationId, { action: "requeue" }, now);
  expect((await claimAgain()).work).toMatchObject({ attempt: 5, ownerAttestation });

  const expired = new Date(now.getTime() - 1);
  application.submitLeaseUntil = expired;
  work.leaseUntil = expired;
  await resolveJobSubmission(tx, ownerId, applicationId, { action: "mark_not_sent" }, now);
  expect((await claimAgain()).work).toMatchObject({ attempt: 6, ownerAttestation });

  await recordJobsSubmissionEvent(tx, current, { eventId: randomUUID(), step: "submit_started", state: "running" });
  application.status = "queued";
  work.state = "queued";
  const afterStart = (await claimAgain()).work;
  expect(afterStart).toMatchObject({ attempt: 7 });
  expect(afterStart).not.toHaveProperty("ownerAttestation");
});

test("expired SES preflight is immediately eligible for an attestation with no reported result", async () => {
  const fixture = submission({ expired: true, sesPreflight: true });
  expect(await resolveAndClaim(fixture)).toMatchObject({
    attempt: 4, ownerAttestation: { previousWorkId: fixture.work.id, previousAttempt: 3, approvedRevision: 2, sha256: fixture.sha256 },
  });
  expect(fixture.events[0]).not.toHaveProperty("payload.ownerAttestation.previousResultId");
});

test("browser and legacy resolutions leave compatible retry claims for older workers", async () => {
  const legacy = submission({ attempts: 0 });
  expect(await resolveAndClaim(legacy)).not.toHaveProperty("ownerAttestation");
  const browser = submission({ startChannel: "browser" });
  await resolveJobSubmission(browser.tx, browser.ownerId, browser.applicationId, { action: "mark_not_sent" }, browser.now);
  const oldWorker = (await claimJobsWork(browser.tx, { ownerId: browser.ownerId, role: "runner" },
    { workerId: "legacy", kinds: ["submit"] }, browser.now)).work;
  expect(oldWorker).toMatchObject({ kind: "submit" });
  expect(oldWorker).not.toHaveProperty("ownerAttestation");
  expect(oldWorker).not.toHaveProperty("attempt");
  expect(browser.events[0]).not.toHaveProperty("payload.ownerAttestation");
});

test("a queued attestation for a different PDF cannot authorize the current approval", async () => {
  const { tx, ownerId, applicationId, now, work } = submission({ startChannel: "ses" });
  await resolveJobSubmission(tx, ownerId, applicationId, { action: "mark_not_sent", expectedUpdatedAt: now.toISOString() }, now);
  const payload = work.payload as { ownerAttestation: { sha256: string } };
  payload.ownerAttestation.sha256 = "c".repeat(64);
  const next = await claimJobsWork(tx, { ownerId, role: "runner" },
    { workerId: "fixture", kinds: ["submit"], supportsOwnerAttestation: true }, now);
  expect(next.work).toMatchObject({ attempt: 4 });
  expect(next.work).not.toHaveProperty("ownerAttestation");
});

test("an expired SES start requires the inspected version and time to finish before Owner retry", async () => {
  const fixture = submission({ expired: true, startChannel: "ses" });
  const { tx, ownerId, applicationId, now } = fixture;
  const action = "mark_not_sent" as const;
  const settledAt = new Date(now.getTime() + 30_000);
  const exact = { action, expectedUpdatedAt: now.toISOString() };
  await expect(resolveJobSubmission(tx, ownerId, applicationId, { action }, settledAt)).rejects.toMatchObject({ status: 409 });
  const stale = { action, expectedUpdatedAt: fixture.work.leaseUntil!.toISOString() };
  await expect(resolveJobSubmission(tx, ownerId, applicationId, stale, settledAt)).rejects.toMatchObject({ status: 409 });
  await expect(resolveJobSubmission(tx, ownerId, applicationId, exact, now)).rejects.toMatchObject({ status: 409 });
  expect(fixture.work.state).toBe("claimed");
  expect(fixture.events).toHaveLength(0);
  await resolveJobSubmission(tx, ownerId, applicationId, exact, settledAt);
  expect(fixture.events[0]).toMatchObject({
    payload: { ownerAttestation: { resolvedAt: settledAt.toISOString() } },
  });
  expect(fixture.events[0]).not.toHaveProperty("payload.ownerAttestation.previousResultId");
});

test("a terminal uncertain SES report can be reconciled immediately with the correct version", async () => {
  const fixture = submission({ startChannel: "ses" });
  await resolveJobSubmission(fixture.tx, fixture.ownerId, fixture.applicationId, {
    action: "mark_not_sent", expectedUpdatedAt: fixture.now.toISOString(),
  }, fixture.now);
  expect(fixture.events[0]).toMatchObject({
    payload: { ownerAttestation: { previousResultId: fixture.resultId, resolvedAt: fixture.now.toISOString() } },
  });
});

test("only the current SES attempt with a durable start accepts definitive refusal as retryable", async () => {
  const report = { leaseToken: "fixture-lease-token", resultId: randomUUID(), code: "runner_unavailable" } as const;
  for (const [startChannel, expired, emailNotSent, failure] of [
    ["ses", false, true, "runner_unavailable"],
    ["ses", false, false, "submission_uncertain"],
    ["ses", true, true, "runner_unavailable"],
    [undefined, false, true, "runner_unavailable"],
    [undefined, true, true, "submission_uncertain"],
    ["browser", false, false, "submission_uncertain"],
    ["browser", false, true, null],
  ] as const) {
    const { work, tx, now, application } = submission({ startChannel, expired });
    Object.assign(work, { state: "claimed", leaseUntil: new Date(now.getTime() + (expired ? -1 : 1)) });
    const completion = failJobsWork(tx, work as unknown as Parameters<typeof failJobsWork>[1],
      { ...report, ...(emailNotSent && { emailNotSent }) }, now);
    if (failure) {
      await completion;
      expect(application).toMatchObject({ status: "needs_attention", issueCode: failure });
      expect(work).toMatchObject({ state: "failed", failureCode: failure });
    } else {
      await expect(completion).rejects.toMatchObject({ status: 409 });
      expect(work.state).toBe("claimed");
    }
  }
});
