import { expect, test } from "bun:test";
import { jobsClient, type ApplicationDetail } from "../../web/app/jobs/jobs-client";

const ownerId = "jobs-owner-fixture";
const ids = [1, 2, 3, 4, 5].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

// Use a fresh, disposable Docker PostgreSQL database named jobs_review_fixture.
test.skipIf(process.env.QUANTSELF_JOBS_REVIEW_FIXTURE !== "1")("the redesigned client opens a bulk, Owner-scoped review session", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/jobs_review_fixture") {
    throw new Error("Use the disposable Jobs Review Docker database.");
  }
  const { prisma } = await import("@quantself/db");
  const { createApp } = await import("./app");
  const fetch = globalThis.fetch;
  try {
    await prisma.$executeRaw`CREATE TYPE "JobResumeTrack" AS ENUM ('engineering', 'web', 'admin')`;
    await prisma.$executeRaw`CREATE TYPE "JobApplicationStatus" AS ENUM ('draft','review','approved','queued','submitting','applied','skipped','disqualified','saved_for_later','rejected','needs_attention')`;
    await prisma.$executeRaw`CREATE TYPE "JobIssueCode" AS ENUM ('model_error','manual_required','submission_uncertain')`;
    await prisma.$executeRaw`CREATE TYPE "JobVerdict" AS ENUM ('strong','review','weak')`;
    await prisma.$executeRaw`
      CREATE TABLE job_application (
        "ownerId" text NOT NULL, id text NOT NULL, company text NOT NULL, role text NOT NULL,
        "resumeTrack" "JobResumeTrack" NOT NULL, status "JobApplicationStatus" NOT NULL, "issueCode" "JobIssueCode",
        "sourceLabel" text, "sourceUrl" text NOT NULL, "updatedAt" timestamp NOT NULL, "appliedAt" timestamp,
        description text NOT NULL, revision int NOT NULL, "approvedRevision" int, summary text NOT NULL, "resumeMarkdown" text,
        "applicationAddress" text, "receiptCode" text, "sesMessageId" text, "brief" jsonb, "dueAt" timestamp, "verdict" "JobVerdict", "submitLeaseUntil" timestamp, location text,
        PRIMARY KEY ("ownerId", id)
      )`;
    await prisma.$executeRaw`
      CREATE TABLE job_revision (
        "ownerId" text NOT NULL, "applicationId" text NOT NULL, revision int NOT NULL, "pdfReference" text, "pdfSha256" text,
        PRIMARY KEY ("ownerId", "applicationId", revision)
      )`;
    await prisma.$executeRaw`
      INSERT INTO job_application VALUES
        (${ownerId}, ${ids[0]}, 'Atlas', 'Editor', 'web', 'review', NULL, 'Board', 'https://example.test/jobs/1',
          '2026-11-14', NULL, 'Edit product pages.', 3, NULL, '- Edit product pages', '## Summary' || chr(10) || '- Edit product pages', NULL, NULL, NULL),
        (${ownerId}, ${ids[1]}, 'Atlas', 'Operator', 'admin', 'review', NULL, NULL, 'https://example.test/jobs/2',
          '2026-11-13', NULL, 'Maintain records.', 1, NULL, 'Records', NULL, NULL, NULL, NULL),
        ('other-owner', ${ids[2]}, 'Atlas', 'Editor', 'web', 'review', NULL, NULL, 'https://example.test/jobs/3',
          '2026-11-15', NULL, 'Private posting.', 1, NULL, 'Private', NULL, NULL, NULL, NULL),
        (${ownerId}, ${ids[3]}, 'Harbor', 'Editor', 'web', 'needs_attention', 'model_error', NULL, 'https://example.test/jobs/4',
          '2026-11-12', NULL, 'Draft unavailable.', 1, NULL, '', NULL, NULL, NULL, NULL),
        (${ownerId}, ${ids[4]}, 'Harbor', 'Assistant', 'admin', 'applied', NULL, NULL, 'https://example.test/jobs/5',
          '2026-11-11', '2026-11-11', 'Applied posting.', 2, 2, 'Admin', NULL, 'luigi.k7mq@luigigirke.com', 'confirmation_message', 'fixture-ses-id')`;

    const app = createApp({
      emitAccessLog: () => {},
      resolveAccessContext: async headers => {
        const kind = headers.get("x-fixture-client");
        if (kind !== "web" && kind !== "api-key") return null;
        return { owner: { id: ownerId, name: "Fixture", email: "fixture@example.test" }, client: { kind, id: "fixture", name: "Fixture" }, permissions: ["jobs:read"] };
      },
    });
    const paths = ["/api/v1/jobs/applications/reviewable?tab=review", `/api/v1/jobs/review-session?ids=${ids[0]}`];
    for (const path of paths) {
      expect((await app.request(path)).status).toBe(401);
      expect((await app.request(path, { headers: { "x-fixture-client": "api-key" } })).status).toBe(403);
    }
    const requests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push(url);
      return app.request(url, { ...init, headers: { "x-fixture-client": "web" } });
    }) as typeof globalThis.fetch;

    const reviewable = await jobsClient.reviewableIds({ tab: "review" });
    expect(reviewable.ids).toEqual(ids.slice(0, 2));
    const { items }: { items: ApplicationDetail[] } = await jobsClient.reviewSession(reviewable.ids);
    expect(requests).toEqual([paths[0], `/api/v1/jobs/review-session?ids=${ids[0]},${ids[1]}`]);
    expect(items.map(row => row.id)).toEqual(reviewable.ids);
    expect(items[0]).toMatchObject({ track: "web", source: "Board", revision: 3,
      postingText: "Edit product pages.", summaryMarkdown: "- Edit product pages", brief: null, pdfUrl: null });
    expect(await jobsClient.reviewableIds({ q: "ATLAS Editor", track: "web", due: "none" })).toEqual({ ids: [ids[0]] });
    expect(await jobsClient.reviewableIds({ tab: "attention" })).toEqual({ ids: [ids[3]] });
    const page = await jobsClient.applications({ q: "atlas", tab: "review", pageSize: 1, page: 2 });
    expect(page).toMatchObject({ rows: [{ id: ids[1] }], total: 2, pageSize: 1, tabCounts: { all: 2, review: 2, attention: 0 } });
    expect(await jobsClient.applications({ q: "atlas", tab: "attention" })).toMatchObject({ rows: [], total: 0, tabCounts: { review: 2 } });
    expect((await jobsClient.reviewSession([ids[1], ids[2], ids[0]])).items.map(row => row.id)).toEqual([ids[1], ids[0]]);
    expect((await app.request("/api/v1/jobs/review-session?ids=bad-id", { headers: { "x-fixture-client": "web" } })).status).toBe(400);
    const evidence = await prisma.$queryRaw`
      SELECT id, "applicationAddress", "receiptCode", "sesMessageId" FROM job_application WHERE "ownerId" = ${ownerId} AND id = ${ids[4]}`;
    expect(evidence).toEqual([{ id: ids[4], applicationAddress: "luigi.k7mq@luigigirke.com", receiptCode: "confirmation_message", sesMessageId: "fixture-ses-id" }]);
  } finally {
    globalThis.fetch = fetch;
    await prisma.$disconnect();
  }
}, 20_000);
