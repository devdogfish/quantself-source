import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@quantself/db/generated/prisma/client";
import { resumeHeader } from "../../../scripts/jobs/resume-document";
import { jobsPostingDetailsInput } from "./jobs-review-contract";
import { approveJobReviewRevision, decideJobReview, editJobReviewRevision } from "./jobs-review-write";
import { failJobsWork } from "./jobs-work-service";

function fixture(status: "review" | "approved" | "needs_attention") {
  const now = new Date("2026-11-16T20:00:00Z");
  const row = {
    ownerId: "fixture", id: randomUUID(), revision: 6, status,
    approvedRevision: status === "approved" ? 6 : null, approvedPreviewDigest: null,
    issueCode: status === "needs_attention" ? "runner_unavailable" : null,
    company: "Fixture Studio", role: "Web Editor", sourceUrl: "https://example.test/jobs/1",
    resumeTrack: "web", updatedAt: now, appliedAt: null, sourceLabel: null, verdict: null, dueAt: null,
    brief: null, description: "Maintain the product catalog.", summary: "- Maintain the catalog.",
    resumeMarkdown: `${resumeHeader}## Summary\n\n- Maintain the catalog.\n`,
  };
  const render = {
    ownerId: row.ownerId, applicationId: row.id, id: randomUUID(), revision: row.revision,
    kind: "render", state: status === "needs_attention" ? "failed" : "claimed", attempts: 1, application: row,
  };
  const queued: string[] = [];
  const tx = {
    jobApplication: {
      findUnique: async () => row,
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data),
      updateManyAndReturn: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(row, { ...data, revision: typeof data.revision === "object" ? row.revision + 1 : row.revision });
        return [row];
      },
    },
    jobRevision: {
      findUnique: async () => ({ summaryMarkdown: row.summary, resumeMarkdown: row.resumeMarkdown, pdfReference: null, pdfSha256: null }),
      create: async () => ({}),
    },
    jobWorkItem: {
      findFirst: async () => render.state === "failed" ? { id: render.id } : null,
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(render, data),
      updateMany: async () => ({ count: 0 }),
      upsert: async ({ create }: { create: { kind: string } }) => { queued.push(create.kind); },
    },
    jobEvent: { create: async () => ({}) },
  } as unknown as Prisma.TransactionClient;
  const reportFailure = () => failJobsWork(
    tx, render as unknown as Parameters<typeof failJobsWork>[1],
    { leaseToken: randomUUID(), resultId: randomUUID(), code: "runner_unavailable" }, now,
  );
  const edit = () => editJobReviewRevision(tx, row.ownerId, row.id, {
    expectedRevision: 6, summaryMarkdown: "- Maintain and audit the product catalog.",
  });
  const later = () => decideJobReview(tx, row.ownerId, row.id, { expectedRevision: row.revision, action: "later" });
  return { row, render, tx, queued, reportFailure, edit, later };
}

test("a preview can fail between saves and the next résumé edit still persists", async () => {
  const job = fixture("review");
  await job.reportFailure();
  expect(job.render.state).toBe("failed");
  expect(job.row.status).toBe("review");
  expect(job.row.issueCode).toBe("runner_unavailable");
  const saved = await job.edit();
  expect(saved.application).toMatchObject({
    revision: 7, status: "review", approvedRevision: null, summaryMarkdown: "- Maintain and audit the product catalog.",
  });
  expect(job.queued).toEqual([]);
});

test("a draft stuck on an old runner preview can be approved for submission rendering", async () => {
  const job = fixture("needs_attention");
  const result = await approveJobReviewRevision(job.tx, job.row.ownerId, job.row.id, job.row.revision);
  expect(result.application).toMatchObject({ status: "approved", issue: null });
  expect(job.row.approvedRevision).toBe(6);
  expect(job.queued).toEqual(["render"]);
});

test("a previously stuck unapproved preview is editable, while approved failures stay in attention", async () => {
  const stuck = fixture("needs_attention");
  expect((await stuck.edit()).application).toMatchObject({ status: "review", revision: 7, approvedRevision: null });
  const approved = fixture("approved");
  await approved.reportFailure();
  expect(approved.row).toMatchObject({ status: "needs_attention", approvedRevision: 6 });
  await expect(approved.edit()).rejects.toThrow("outside résumé review");
});

test("Later saves an existing draft with a failed unapproved preview without queueing work", async () => {
  const job = fixture("needs_attention");
  expect(await job.later()).toMatchObject({ application: { status: "saved_for_later", issue: null } });
  expect(job.row).toMatchObject({ revision: 6, summary: "- Maintain the catalog.", approvedRevision: null });
  expect(job.queued).toEqual([]);
  const approved = fixture("approved");
  await approved.reportFailure();
  await expect(approved.later()).rejects.toThrow("outside résumé review");
});

test("posting details must remain shorter than the employer's description", () => {
  const input = { expectedRevision: 6, previousText: "Catalog.", postingText: "Maintain Shopify product listings.", sourceWordCount: 5 };
  expect(jobsPostingDetailsInput.safeParse(input).success).toBe(true);
  expect(jobsPostingDetailsInput.safeParse({ ...input, sourceWordCount: 4 }).success).toBe(false);
});
