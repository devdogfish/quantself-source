import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobsClient } from "../../web/app/jobs/jobs-client";
import { resumeHeader } from "../../../scripts/jobs/resume-document";
import { jobsReviewPatchOutput } from "./jobs-review-contract";

const ownerId = "jobs-owner-fixture";
const otherOwnerId = "unrelated-jobs-owner-fixture";
const reviewId = "4ffd2a72-3673-418f-a446-1edc725ea366";
const appliedId = "b8143873-a95b-4168-abca-9513c5efaa61";
const otherId = "6dde01cb-fbf5-4ee2-9bbf-63f4dbaab328";
const agentId = "75eb0ab5-b0a4-44e8-8c47-2cb3b3559652";
const legacyId = "5b3a0fa4-b556-4bcb-a730-6a90bfdf8e26";
const document = (summary: string) => `${resumeHeader}## Summary\n\n${summary}\n\n## Experience\n\n- Edited product pages\n`;

// Apply the real migrations to a fresh disposable Docker database before running this fixture.
test.skipIf(process.env.QUANTSELF_JOBS_WRITE_FIXTURE !== "1")("Owner revision edits and approvals persist atomically", async () => {
  const connection = new URL(process.env.DATABASE_URL ?? "");
  if (connection.protocol !== "postgresql:" || connection.hostname !== "127.0.0.1" || !connection.port || connection.pathname !== "/jobs_write_fixture") {
    throw new Error("Use a disposable Jobs write Docker database.");
  }
  const { prisma } = await import("@quantself/db");
  const { createApp } = await import("./app");
  const fetch = globalThis.fetch;
  const templateDir = await mkdtemp(join(tmpdir(), "jobs-review-fixture-"));
  const previousTemplateDir = process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
  try {
    const appliedAt = new Date("2026-11-10T13:30:00Z");
    const shared = { company: "Example", role: "Editor", resumeTrack: "web" as const };
    await prisma.jobApplication.createMany({ data: [
      { ...shared, ownerId, id: reviewId, sourceKey: "review", sourceUrl: "https://example.test/job/1", status: "review",
        summary: "- Edit product pages", resumeMarkdown: document("- Edit product pages"), hasResumeMarkdown: true },
      { ...shared, ownerId, id: appliedId, sourceKey: "applied", sourceUrl: "https://example.test/job/2", status: "applied",
        applicationAddress: "luigi.k7mq@luigigirke.com", appliedAt, receiptCode: "confirmation_message", sesMessageId: "fixture-ses-id",
        revision: 5, approvedRevision: 4 },
      { ...shared, ownerId: otherOwnerId, id: otherId, sourceKey: "other", sourceUrl: "https://example.test/job/3", status: "review" },
      { ...shared, ownerId, id: agentId, sourceKey: "agent", sourceUrl: "https://example.test/job/4", lastOwnerEditedAt: new Date() },
      { ...shared, ownerId, id: legacyId, sourceKey: "legacy", sourceUrl: "https://example.test/job/5",
        status: "review", summary: "- Tailored legacy summary" },
    ] });
    const [privateAnswer, registry] = await Promise.all([
      prisma.jobPrivateField.create({ data: { ownerId, scopeKey: `listing:${appliedId}`, key: "answer", label: "Fixture answer", type: "text", ciphertext: "encrypted-fixture", hasValue: true } }),
      prisma.trackedLink.create({ data: { applicationId: appliedId, code: "b".repeat(24), kind: "application", company: "Example", title: "Editor", track: "web-cms", revision: 5 } }),
    ]);
    await prisma.jobRevision.create({ data: {
      ownerId, applicationId: reviewId, revision: 1, summaryMarkdown: "- Edit product pages", resumeMarkdown: document("- Edit product pages"),
    } });
    expect(await prisma.trackedLink.findUnique({ where: { applicationId: appliedId } })).toEqual(registry);
    expect(await prisma.jobPrivateField.findUnique({ where: { ownerId_id: { ownerId, id: privateAnswer.id } } })).toEqual(privateAnswer);

    const app = createApp({
      emitAccessLog: () => {},
      resolveAccessContext: async headers => {
        const kind = headers.get("x-fixture-client");
        if (kind !== "web" && kind !== "api-key" && kind !== "agent") return null;
        return {
          owner: { id: ownerId, name: "Fixture", email: "fixture@example.test" },
          client: kind === "agent" ? { kind, id: "jobs-write-fixture-agent", name: "Fixture Agent", avatar: null }
            : { kind, id: "jobs-write-fixture-client", name: "Fixture" },
          permissions: ["jobs:read", "jobs:write", "jobs:execute"],
        };
      },
    });
    const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost").origin;
    const requests: { key: string | null; body: string | null }[] = [];
    let loseApprovalResponse = true;
    let holdEdit = false;
    const editCommitted = Promise.withResolvers<void>();
    const releaseEdit = Promise.withResolvers<void>();
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      headers.set("x-fixture-client", "web");
      headers.set("Origin", origin);
      requests.push({ key: headers.get("Idempotency-Key"), body: typeof init?.body === "string" ? init.body : null });
      const response = await app.request(url, { ...init, headers });
      if (url.endsWith("/decision") && loseApprovalResponse && response.ok) {
        loseApprovalResponse = false;
        throw new TypeError("fixture lost the committed response");
      }
      if (holdEdit && init?.method === "PATCH" && response.ok) {
        holdEdit = false;
        editCommitted.resolve();
        await releaseEdit.promise;
      }
      return response;
    }) as typeof globalThis.fetch;

    const approved = await jobsClient.decide(reviewId, 1, { action: "approve" }, "approval-1");
    expect(approved.application.status).toBe("approved");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(await prisma.jobEvent.count({ where: { applicationId: reviewId, kind: "approved" } })).toBe(1);
    expect(await prisma.jobWorkItem.findMany({ where: { applicationId: reviewId }, select: { kind: true, revision: true } })).toEqual([{ kind: "render", revision: 1 }]);

    holdEdit = true;
    const edit = { summaryMarkdown: "- Improve product pages" };
    const inFlight = jobsClient.saveResume(reviewId, 1, edit, "edit-1");
    await editCommitted.promise;
    let replay: Awaited<typeof inFlight>;
    try { replay = await jobsClient.saveResume(reviewId, 1, edit, "edit-1"); }
    finally { releaseEdit.resolve(); }
    expect(await inFlight).toEqual(replay);
    expect(replay.application).toMatchObject({ id: reviewId, revision: 2, approvedRevision: null, status: "review",
      summaryMarkdown: edit.summaryMarkdown, resumeMarkdown: document(edit.summaryMarkdown) });
    await expect(jobsClient.saveResume(reviewId, 1, edit, "stale-edit")).rejects.toMatchObject({ status: 409 });
    await expect(jobsClient.saveResume(reviewId, 1, { summaryMarkdown: "- Different" }, "edit-1")).rejects.toMatchObject({ status: 409 });
    await expect(jobsClient.decide(reviewId, 1, { action: "approve" }, "stale-approval")).rejects.toMatchObject({ status: 409 });
    await expect(jobsClient.saveResume(otherId, 1, edit, "cross-owner")).rejects.toMatchObject({ status: 404 });
    expect((await app.request(`/api/v1/jobs/applications/${reviewId}`, {
      method: "PATCH", headers: { "x-fixture-client": "api-key", "Content-Type": "application/json", "Idempotency-Key": "api-key-edit" },
      body: JSON.stringify({ expectedRevision: 2, ...edit }),
    })).status).toBe(403);

    expect(await prisma.jobWorkItem.count({ where: { applicationId: reviewId, revision: 2 } })).toBe(0);
    // An attachment saved by an older release can still be reused for exactly this revision.
    await prisma.jobRevision.update({ where: { ownerId_applicationId_revision: { ownerId, applicationId: reviewId, revision: 2 } },
      data: { pdfReference: "fixture.pdf", pdfSha256: "a".repeat(64) } });
    expect((await jobsClient.decide(reviewId, 2, { action: "approve" }, "approval-2")).application.status).toBe("queued");
    const full = await jobsClient.saveResume(reviewId, 2, { resumeMarkdown: document("- Publish product pages") }, "edit-2");
    expect(full.application).toMatchObject({ revision: 3, status: "review", approvedRevision: null, summaryMarkdown: "- Publish product pages" });
    expect(await prisma.jobWorkItem.findMany({ where: { applicationId: reviewId, kind: "submit" }, select: { revision: true, state: true, failureCode: true } }))
      .toEqual([{ revision: 2, state: "failed", failureCode: "stale_revision" }]);
    expect(await prisma.jobRevision.findMany({ where: { applicationId: reviewId }, orderBy: { revision: "asc" }, select: { revision: true, summaryMarkdown: true } })).toEqual([
      { revision: 1, summaryMarkdown: "- Edit product pages" }, { revision: 2, summaryMarkdown: "- Improve product pages" }, { revision: 3, summaryMarkdown: "- Publish product pages" },
    ]);
    expect(await prisma.jobEvent.count({ where: { applicationId: reviewId, kind: "revision_edited" } })).toBe(2);

    process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = templateDir;
    await writeFile(join(templateDir, "web.md"), document("- Base summary"));
    const legacyKey = { ownerId, applicationId: legacyId, revision: 1 };
    const merged = document("- Tailored legacy summary");
    await prisma.jobRevision.create({ data: { ...legacyKey, summaryMarkdown: "- Tailored legacy summary" } });
    const legacySession = await jobsClient.reviewSession([legacyId]);
    expect(legacySession.items[0]).toMatchObject({ resumeMarkdown: merged, revision: 1, pdfUrl: null });
    expect(await prisma.jobWorkItem.count({ where: legacyKey })).toBe(0);
    expect((await prisma.jobRevision.findUniqueOrThrow({ where: { ownerId_applicationId_revision: legacyKey } })).resumeMarkdown).toBeNull();
    expect((await jobsClient.decide(legacyId, 1, { action: "approve" }, "approve-legacy")).application.status).toBe("approved");
    expect((await prisma.jobRevision.findUniqueOrThrow({ where: { ownerId_applicationId_revision: legacyKey } })).resumeMarkdown).toBe(merged);
    expect(await prisma.jobWorkItem.findMany({ where: legacyKey, select: { kind: true, state: true } }))
      .toEqual([{ kind: "render", state: "queued" }]);

    globalThis.fetch = fetch;
    const agentEdit = (key: string) => app.request(`/api/v1/jobs/applications/${agentId}`, {
      method: "PATCH",
      headers: { "x-fixture-client": "agent", "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ expectedRevision: 1, summaryMarkdown: "- Updated product listings" }),
    });
    expect((await agentEdit("agent-too-soon")).status).toBe(409);
    await prisma.jobApplication.update({ where: { ownerId_id: { ownerId, id: agentId } }, data: { lastOwnerEditedAt: new Date(0) } });
    const changed = await agentEdit("agent-edit");
    expect(changed.status).toBe(200);
    const audit = jobsReviewPatchOutput.parse(await changed.json());
    const auditId = audit.auditId;
    if (!auditId) throw new Error("Expected an Agent write audit ID.");
    expect(audit.application).toMatchObject({ summaryMarkdown: "- Updated product listings", revision: 2 });
    expect(await (await agentEdit("agent-edit")).json()).toEqual(audit);
    const undo = await app.request(`/api/v1/agent-audit/${auditId}/undo`, {
      method: "POST", headers: { "x-fixture-client": "web", Origin: origin, "Idempotency-Key": "agent-undo" },
    });
    expect({ status: undo.status, body: await undo.json() }).toMatchObject({
      status: 200, body: { audit: { id: auditId, undoneAt: expect.any(String) } },
    });
    expect(await prisma.jobRevision.findUnique({ where: { ownerId_applicationId_revision: { ownerId, applicationId: agentId, revision: 3 } } }))
      .toMatchObject({ summaryMarkdown: "", author: "owner" });

    const history = await app.request("/api/v1/jobs/applications/import", {
      method: "POST", headers: { "x-fixture-client": "api-key", "Content-Type": "application/json", "Idempotency-Key": "import-history" },
      body: JSON.stringify({ applications: [{
        company: "Example", role: "Another editor", sourceUrl: "https://example.test/job/history", track: "web",
        postingText: "Previously filed application.", recordedStatus: "applied",
      }] }),
    });
    expect({ status: history.status, body: await history.json() }).toEqual({ status: 200, body: { imported: 1, duplicates: 0 } });
    const imported = await prisma.jobApplication.findFirstOrThrow({ where: { ownerId, sourceUrl: "https://example.test/job/history" } });
    expect(imported.status).toBe("applied");
    expect(await prisma.jobWorkItem.count({ where: { ownerId, applicationId: imported.id } })).toBe(0);
  } finally {
    globalThis.fetch = fetch;
    if (previousTemplateDir === undefined) delete process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
    else process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = previousTemplateDir;
    await rm(templateDir, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}, 25_000);
