import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@quantself/db/generated/prisma/client";
import { jobsOverviewOutput, jobsSubmissionsOutput, readJobsOverview, readJobsSubmissions } from "./jobs-operations-read";
import { approvedJobSnapshot } from "./jobs-private-pause";
import { questionKey } from "../../../scripts/jobs/private-fields";

const runFixture = process.env.QUANTSELF_JOBS_OPERATIONS_FIXTURE === "1";
const now = new Date("2026-11-14T20:00:00Z");
const ago = (milliseconds: number) => new Date(now.getTime() - milliseconds);
const day = 86_400_000;
const sourceUrl = "https://example.test/synthetic-post";

function row(ownerId: string, fields: Partial<Prisma.JobApplicationCreateManyInput> = {}): Prisma.JobApplicationCreateManyInput {
  const id = randomUUID();
  return { id, ownerId, sourceKey: id, sourceUrl, company: "Synthetic Studio", role: "Web Editor",
    resumeTrack: "web", status: "draft", createdAt: ago(day), updatedAt: ago(3000), ...fields };
}

async function fixture(run: (db: PrismaClient, ownerId: string, otherOwnerId: string) => Promise<void>) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/jobs_operations_fixture") {
    throw new Error("Use a fresh disposable Docker database named jobs_operations_fixture.");
  }
  const { prisma } = await import("@quantself/db");
  const owners = [randomUUID(), randomUUID()] as const;
  try { await run(prisma, ...owners); }
  finally {
    await prisma.jobApplication.deleteMany({ where: { ownerId: { in: [...owners] } } });
    await prisma.jobRunner.deleteMany({ where: { ownerId: { in: [...owners] } } });
    await prisma.$disconnect();
  }
}

function countReads(prisma: PrismaClient) {
  const calls: string[] = [];
  const db: Parameters<typeof readJobsOverview>[0] = {
    $queryRaw<T>(...args: Parameters<PrismaClient["$queryRaw"]>) {
      calls.push("jobs");
      return prisma.$queryRaw<T>(...args);
    },
    jobRunner: { findUnique(args) {
      calls.push("runner");
      return prisma.jobRunner.findUnique(args);
    } },
  };
  return { db, calls };
}

test.skipIf(!runFixture)("Overview reads bounded Owner aggregates and historical approval without treating a receipt as a response", async () => {
  await fixture(async (prisma, ownerId, otherOwnerId) => {
    const coldStart = performance.now();
    const empty = jobsOverviewOutput.parse(await readJobsOverview(prisma, ownerId, now));
    const coldMs = Math.round(performance.now() - coldStart);
    expect(empty).toMatchObject({
      waitingOnYou: 0, waitingOnRunner: 0, runner: { state: "offline", host: null, lastHeartbeatAt: null },
      metrics: { applied: 0, approvalRate: 0, responseRate: 0, medianDaysToApply: null },
      pipeline: { drafted: 0, reviewed: 0, approved: 0, applied: 0 },
    });
    expect(empty.weekly).toHaveLength(10);
    expect(empty.weekly.at(-1)).toEqual({ week: "Nov 9", drafted: 0, applied: 0 });

    const rejected = row(ownerId, { status: "rejected", verdict: "review", createdAt: ago(42 * day) });
    const review = row(ownerId, { status: "review", verdict: "strong" });
    await prisma.jobApplication.createMany({ data: [
      row(ownerId, { status: "draft", verdict: "review" }), review, rejected,
      row(ownerId, { status: "approved", verdict: "strong", approvedRevision: 1 }),
      row(ownerId, { status: "submitting", verdict: "review", approvedRevision: 1, submitLeaseUntil: new Date(now.getTime() + 1000) }),
      row(ownerId, { status: "submitting", verdict: "weak", approvedRevision: 1, submitLeaseUntil: now }),
      row(ownerId, { status: "applied", appliedAt: ago(2 * day), createdAt: ago(6 * day), receiptCode: "confirmation_page" }),
      row(ownerId, { status: "applied", appliedAt: ago(44 * day), createdAt: ago(47 * day), receiptCode: "confirmation_message" }),
      row(ownerId, { status: "skipped", verdict: "weak", createdAt: ago(43 * day) }),
      row(otherOwnerId, { id: review.id, status: "applied", verdict: "strong", appliedAt: ago(day) }),
    ] });
    await prisma.jobEvent.createMany({ data: [
      { applicationId: rejected.id!, ownerId, kind: "approved", occurredAt: ago(40 * day) },
      { applicationId: rejected.id!, ownerId, kind: "approved", occurredAt: ago(39 * day) },
      { applicationId: rejected.id!, ownerId, kind: "rejected", occurredAt: ago(38 * day) },
      { applicationId: review.id!, ownerId, kind: "revision_edited", occurredAt: ago(8000) },
      { applicationId: review.id!, ownerId: otherOwnerId, kind: "approved", occurredAt: ago(7000) },
    ] });
    await prisma.jobRunner.createMany({ data: [
      { ownerId, host: "fixture-mac", lastHeartbeatAt: ago(3000) },
      { ownerId: otherOwnerId, host: "other-mac", lastHeartbeatAt: now, paused: true },
    ] });
    const { db, calls } = countReads(prisma);
    const warmStart = performance.now();
    const overview = jobsOverviewOutput.parse(await readJobsOverview(db, ownerId, now));
    console.info(`Overview fixture: ${coldMs}ms first read, ${Math.round(performance.now() - warmStart)}ms warm, ${calls.length} queries.`);
    expect(calls.toSorted()).toEqual(["jobs", "runner"]);
    expect(overview).toMatchObject({
      waitingOnYou: 2, waitingOnRunner: 2, runner: { state: "submitting", host: "fixture-mac", lastHeartbeatAt: ago(3000).toISOString() },
      metrics: { applied: 1, approvalRate: 6 / 8, responseRate: 0, medianDaysToApply: 3.5 },
      pipeline: { drafted: 9, reviewed: 8, approved: 6, applied: 2 },
      alignment: [
        { verdict: "strong", drafts: 2, approved: 1, skipped: 0, rejected: 0 },
        { verdict: "review", drafts: 3, approved: 1, skipped: 0, rejected: 1 },
        { verdict: "weak", drafts: 2, approved: 1, skipped: 1, rejected: 0 },
      ],
    });
    expect(overview.weekly.at(-1)).toEqual({ week: "Nov 9", drafted: 5, applied: 1 });
    expect((await readJobsOverview(prisma, ownerId, new Date(ago(3000).getTime() + 120_000))).runner.state).toBe("offline");
    await prisma.jobRunner.update({ where: { ownerId }, data: { paused: true, lastHeartbeatAt: ago(day) } });
    expect((await readJobsOverview(prisma, ownerId, now)).runner.state).toBe("paused");
  });
}, 20_000);

test.skipIf(!runFixture)("Submissions retains every actionable row, bounds applied history, and exposes only verified pause keys", async () => {
  await fixture(async (prisma, ownerId, otherOwnerId) => {
    const coldStart = performance.now();
    const empty = await readJobsSubmissions(prisma, ownerId, now);
    const coldMs = Math.round(performance.now() - coldStart);
    expect(empty).toEqual({
      runner: { state: "offline", host: null, lastHeartbeatAt: null }, items: [],
    });
    const active = row(ownerId, { revision: 2, approvedRevision: 2, status: "submitting", submitLeaseUntil: new Date(now.getTime() + 1000) });
    const terminal = row(ownerId, { revision: 2, approvedRevision: 2, status: "applied", receiptCode: "confirmation_page",
      appliedAt: ago(2000), updatedAt: now });
    const expired = row(ownerId, { revision: 2, approvedRevision: 2, status: "submitting", submitLeaseUntil: now });
    const pause = row(ownerId, { revision: 2, approvedRevision: 2, status: "needs_attention", issueCode: "manual_required",
      summary: "Synthetic Summary", resumeMarkdown: "Synthetic résumé.", hasResumeMarkdown: true, updatedAt: ago(365 * day) });
    const changed = row(ownerId, { revision: 2, approvedRevision: 2, status: "needs_attention", issueCode: "manual_required" });
    const oldQueued = row(ownerId, { status: "queued", approvedRevision: 1, updatedAt: ago(366 * day) });
    const oldApplied = row(ownerId, { status: "applied", receiptCode: "confirmation_message", appliedAt: ago(367 * day), updatedAt: now });
    const key = questionKey("Application source");
    const scope = { kind: "listing", applicationId: pause.id! } as const;
    const snapshot = approvedJobSnapshot({ id: pause.id!, company: pause.company, role: pause.role, sourceUrl,
      summary: pause.summary!, resumeTrack: "web", resumeMarkdown: pause.resumeMarkdown });
    const fields = [{ key, scope, label: "Application source", type: "text" }];
    const privatePause = { snapshot, fields, approvalRevision: 2, previewDigest: "a".repeat(64), keys: [`listing:${pause.id}:${key}`] };
    await prisma.jobApplication.createMany({ data: [
      active, terminal, expired, oldQueued, oldApplied, { ...pause, privatePause }, { ...changed, privatePause },
      row(ownerId, { status: "needs_attention", issueCode: "model_error" }),
      row(ownerId, { status: "review" }),
      row(otherOwnerId, { id: active.id, status: "submitting", approvedRevision: 2, revision: 2 }),
    ] });
    await prisma.jobRunner.create({ data: { ownerId, host: "test-mac", lastHeartbeatAt: ago(500) } });
    const step = (application: typeof active, name: string, at: Date, durationMs?: number): Prisma.JobEventCreateManyInput => ({
      ownerId, applicationId: application.id!, revision: 2, kind: "submission_step", occurredAt: at,
      payload: { attempt: 100, state: "done", step: name, ...(durationMs === undefined ? {} : { durationMs }) },
    });
    const formsFilled = step(active, "form_filled", ago(500));
    await prisma.jobEvent.createMany({ data: [
      ...Array.from({ length: 90 }, (_, index): Prisma.JobEventCreateManyInput => ({
        ownerId, applicationId: active.id!, revision: 2, kind: "work_failed", occurredAt: ago(20_000 + index),
        payload: { attempt: 90 - index, code: "manual_required", unprojected: "private payload" },
      })),
      step(active, "runner_claimed", ago(5000)), step(active, "portal_opened", ago(3000), 2000),
      { ...formsFilled, revision: 1 }, { ...formsFilled, ownerId: otherOwnerId },
      step(terminal, "runner_claimed", ago(8000)),
      { ownerId, applicationId: terminal.id!, revision: 2, kind: "receipt_recorded", occurredAt: ago(2000),
        payload: { attempt: 100, code: "confirmation_page", sesMessageId: "private-legacy-receipt" } },
    ] });
    await prisma.jobApplication.createMany({ data: [
      ...Array.from({ length: 107 }, () => row(ownerId, { status: "applied", receiptCode: "confirmation_message", appliedAt: ago(day) })),
      ...Array.from({ length: 110 }, () => row(ownerId, { status: "queued", approvedRevision: 1 })),
    ] });

    const { db, calls } = countReads(prisma);
    const warmStart = performance.now();
    const view = await readJobsSubmissions(db, ownerId, now);
    console.info(`Submissions fixture: ${coldMs}ms first read, ${Math.round(performance.now() - warmStart)}ms warm, ${calls.length} queries, ${view.items.length} items.`);
    expect(jobsSubmissionsOutput.safeParse(view).success).toBe(true);
    expect(calls.toSorted()).toEqual(["jobs", "runner"]);
    const actionable = view.items.filter(item => item.status !== "applied");
    expect(actionable).toHaveLength(115);
    expect(view.items.filter(item => item.status === "applied")).toHaveLength(100);
    expect(actionable.some(item => item.id === oldQueued.id)).toBe(true);
    expect(view.items.some(item => item.id === oldApplied.id)).toBe(false);
    expect(view.runner.state).toBe("submitting");
    expect(view.items[0]).toMatchObject({ id: active.id, phase: "Filling form", durationMs: 5000, receipt: null });
    expect(view.items[0].steps[3]).toMatchObject({ state: "done", durationMs: 2000 });
    const attempts = view.items[0].steps[4].attempts;
    expect(view.items[0].steps[4].state).toBe("running");
    expect(attempts).toHaveLength(5);
    expect(attempts.at(-1)).toEqual({ at: ago(20_000).toISOString(), error: "The form needs Owner input." });
    expect(actionable.find(item => item.id === pause.id)).toMatchObject({ privatePauseFieldKeys: [key] });
    expect(view.items.find(item => item.id === changed.id)?.privatePauseFieldKeys).toBeUndefined();
    const uncertain = view.items.find(item => item.id === expired.id);
    expect(uncertain).toMatchObject({ status: "needs_attention", issue: "submission_uncertain", phase: null });
    expect(uncertain?.steps[5].state).toBe("failed");
    const applied = view.items.find(item => item.id === terminal.id);
    expect(applied).toMatchObject({ receipt: "confirmation_page", durationMs: 6000 });
    expect(applied?.steps[6].state).toBe("done");
    expect(view.items.some(item => item.issue === "model_error" || item.status === "review")).toBe(false);
    expect(JSON.stringify(view)).not.toContain("private-legacy-receipt");
    expect(JSON.stringify(view)).not.toContain("private payload");
    expect(JSON.stringify(view)).not.toContain("Synthetic résumé.");
  });
}, 20_000);
