import { expect, test } from "bun:test";

const phase = process.env.QUANTSELF_JOBS_CUTOVER_FIXTURE;
const ownerId = "jobs-cutover-fixture-owner";
const applied = "00000000-0000-4000-8000-000000002931";
const paused = "00000000-0000-4000-8000-000000002932";
const submitting = "00000000-0000-4000-8000-000000002933";
const modern = "00000000-0000-4000-8000-000000002934";
const privateAnswer = "00000000-0000-4000-8000-000000002935";
const sentAt = new Date("2026-11-10T13:30:00Z");
const question = "question." + "a".repeat(64);
const digest = "b".repeat(64);

// Apply migrations through 20261114200200, run seed, apply the remaining migrations, then verify.
test.skipIf(phase !== "seed" && phase !== "verify")("Jobs cutover preserves source records and converts legacy delivery safely", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/jobs_cutover_fixture") {
    throw new Error("Use the disposable Jobs cutover Docker database.");
  }
  const { prisma } = await import("@quantself/db");
  try {
    if (phase === "seed") {
      await prisma.$transaction(async tx => {
        await tx.$executeRaw`
          INSERT INTO job_application (
            "ownerId", id, "sourceKey", "sourceUrl", company, role, "resumeTrack", status, revision, "approvedRevision",
            summary, "applicationAddress", "appliedAt", "receiptCode", "sesMessageId", "issueCode", "updatedAt", "workflowVersion"
          ) VALUES
            (${ownerId}, ${applied}, 'applied', 'https://example.test/applied', 'Example', 'Editor', 'web', 'applied',
              5, 4, 'Edited product pages', 'luigi.h7mq@luigigirke.com', ${sentAt}, 'confirmation_message', 'fixture-ses-id', NULL, ${sentAt}, 1),
            (${ownerId}, ${paused}, 'paused', 'https://example.test/paused', 'Example', 'Editor', 'web', 'needs_attention',
              2, 2, 'Edited product pages', 'luigi.h7mr@luigigirke.com', NULL, NULL, NULL, 'manual_required', ${sentAt}, 1),
            (${ownerId}, ${submitting}, 'sending', 'https://example.test/sending', 'Example', 'Editor', 'web', 'submitting',
              2, 2, 'Edited product pages', 'luigi.h7ms@luigigirke.com', NULL, NULL, NULL, NULL, ${sentAt}, 1),
            (${ownerId}, ${modern}, 'queued', 'https://example.test/queued', 'Example', 'Editor', 'web', 'queued',
              2, 2, 'Edited product pages', 'luigi.h7mt@luigigirke.com', NULL, NULL, NULL, NULL, ${sentAt}, 2)
          ON CONFLICT DO NOTHING`;
        const pause = JSON.stringify({ approvalRevision: 2, previewDigest: digest, snapshot: digest,
          keys: [`listing:${paused}:${question}`], fields: [{ key: question }] });
        await tx.$executeRaw`UPDATE job_application SET "privatePause" = ${pause}::jsonb WHERE "ownerId" = ${ownerId} AND id = ${paused}`;
        await tx.$executeRaw`
          INSERT INTO job_work ("ownerId", id, "applicationId", kind, state, revision, "previewDigest")
          VALUES (${ownerId}, 'historical-attempt', ${submitting}, 'submit', 'claimed', 2, ${digest}) ON CONFLICT DO NOTHING`;
        await tx.jobPrivateField.createMany({ skipDuplicates: true, data: [{
          ownerId, id: privateAnswer, scopeKey: `listing:${paused}`, key: question, label: "Fixture answer",
          type: "text", hasValue: true, ciphertext: "fixture-encrypted-value",
        }] });
        await tx.$executeRaw`
          INSERT INTO "WebsiteApplication" ("applicationId", code, company, role, cohort)
          VALUES (${applied}::uuid, ${"d".repeat(24)}, 'Example', 'Editor', 'web-cms') ON CONFLICT DO NOTHING`;
        await tx.jobRevision.createMany({ skipDuplicates: true, data: [{
          ownerId, applicationId: modern, revision: 2, summaryMarkdown: "Edited product pages", pdfReference: "fixture.pdf", pdfSha256: digest,
        }] });
        await tx.jobWorkItem.createMany({ skipDuplicates: true, data: [{ ownerId, applicationId: modern, revision: 2, kind: "submit" }] });
      });
      expect((await prisma.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM job_application WHERE "ownerId" = ${ownerId}`)[0].count).toBe(4);
      return;
    }
    const [row, pause, live, kept] = await Promise.all([applied, paused, submitting, modern].map(id =>
      prisma.jobApplication.findUniqueOrThrow({ where: { ownerId_id: { ownerId, id } } })));
    expect(row).toMatchObject({
      id: applied, applicationAddress: "luigi.h7mq@luigigirke.com", appliedAt: sentAt, approvedRevision: 4, updatedAt: sentAt,
      receiptCode: "confirmation_message", sesMessageId: "fixture-ses-id",
      receipt: { source: "legacy", code: "confirmation_message", appliedAt: sentAt.toISOString(), sesMessageId: "fixture-ses-id" },
    });
    expect(pause).toMatchObject({ id: paused, status: "review", approvedRevision: null, privatePause: null });
    expect(live).toMatchObject({ id: submitting, status: "needs_attention", issueCode: "submission_uncertain", approvedRevision: 2 });
    expect(kept).toMatchObject({ id: modern, status: "queued", approvedRevision: 2 });
    expect(await prisma.jobRevision.count({ where: { ownerId } })).toBe(4);
    expect(await prisma.jobEvent.count({ where: { ownerId, applicationId: applied, kind: "receipt_recorded" } })).toBe(1);
    expect(await prisma.jobEvent.findFirst({ where: { ownerId, applicationId: paused, kind: "legacy_cutover" } }))
      .toMatchObject({ payload: { privatePause: { keys: [`listing:${paused}:${question}`] }, approvedRevision: 2 } });
    expect(await prisma.jobEvent.findFirst({ where: { ownerId, applicationId: submitting, kind: "legacy_work" } }))
      .toMatchObject({ payload: { state: "claimed", previewDigest: digest } });
    expect(await prisma.jobPrivateField.findUnique({ where: { ownerId_id: { ownerId, id: privateAnswer } } }))
      .toMatchObject({ scopeKey: `listing:${paused}`, key: question, ciphertext: "fixture-encrypted-value", hasValue: true });
    expect(await prisma.trackedLink.findUnique({ where: { applicationId: applied } })).toMatchObject({ code: "d".repeat(24), applicationId: applied, kind: "application", sentAt });
    expect(await prisma.jobWorkItem.findMany({ where: { ownerId }, select: { applicationId: true, state: true } }))
      .toEqual([{ applicationId: modern, state: "queued" }]);
    expect(await prisma.$queryRaw<{ old_queue: string | null }[]>`SELECT to_regclass('job_work')::text AS old_queue`).toEqual([{ old_queue: null }]);
  } finally { await prisma.$disconnect(); }
}, 25_000);
