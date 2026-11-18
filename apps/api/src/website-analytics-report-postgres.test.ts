import { expect, test } from "bun:test";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { jobSearchReportOutput, websiteReportOutput, websiteShare } from "./website-analytics-report-contract";
import { loadJobSearchReport, loadWebsiteReport } from "./website-analytics-report-store";

const now = Date.parse("2026-11-14T18:00:00Z");
const owner = { id: "website-report-owner", name: "Fixture Owner", email: "report@example.test" };
const firstId = "10000000-0000-4000-8000-000000000001";
const interviewId = "10000000-0000-4000-8000-000000000002";
const interviewCode = "A".repeat(15) + "2";
const zeroCode = "00000000ABCDEF12";
const firstCode = "A".repeat(15) + "1";
const inquiry = "20000000-0000-4000-8000-000000000001";

test.skipIf(process.env.QUANTSELF_WEBSITE_REPORT_DB_TEST !== "1")(
  "native reports use one SQL request on 40,000 events and preserve link and inquiry data",
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/website_report_fixture") {
      throw new Error("Use a fresh disposable website_report_fixture PostgreSQL database.");
    }
    const [{ prisma }, { createApp }, { lookupTrackedLink }] = await Promise.all([import("@quantself/db"), import("./app"), import("./tracked-links-store")]);
    let queries = 0;
    const reader: Pick<PrismaClient, "$queryRaw"> = {
      $queryRaw: (query, ...values) => { queries++; return prisma.$queryRaw(query, ...values); },
    };
    try {
      await prisma.user.create({ data: owner });
      await prisma.jobApplication.create({ data: {
        ownerId: owner.id, id: firstId, company: "Jobs company", role: "Jobs title",
        sourceUrl: "https://example.test/jobs/1", sourceKey: "report-fixture", resumeTrack: "web", status: "rejected",
      } });
      await prisma.jobApplication.create({ data: {
        ownerId: owner.id, id: interviewId, company: "Interview company", role: "Interview role",
        sourceUrl: "https://example.test/jobs/2", sourceKey: "report-interview-fixture", resumeTrack: "web",
        status: "applied", appliedAt: new Date("2026-09-01T18:00:00Z"),
      } });
      await prisma.$executeRaw`
        INSERT INTO tracked_link (code, kind, application_id, company, title, track, revision, sent_at)
        SELECT lpad(n::text, 16, 'A'), 'application', ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
          'Registry company', 'Registry title', 'web-cms', 1, '2026-09-01T18:00:00'
        FROM generate_series(1, 1199) AS n`;
      await prisma.trackedLink.create({ data: {
        code: zeroCode, kind: "application", applicationId: "10000000-0000-4000-8000-000000001200",
        company: "No activity", title: "Draft", track: "software", revision: 1,
      } });
      await prisma.trackedLink.create({ data: {
        code: "Share123", kind: "share", title: "Fixture share", track: "client",
        createdAt: new Date(now - 2 * 86_400_000),
      } });
      await prisma.websiteInquiry.create({ data: {
        id: inquiry, name: "Example", topic: "Project inquiry", email: "customer@example.test",
        message: "Private message", linkCode: "Share123", receivedAt: new Date(now - 1_000),
      } });
      await prisma.$executeRaw`
        INSERT INTO website_event (id, occurred_at, kind, visitor_id, session_id, page_view_id, path, link_code, device, props)
        SELECT gen_random_uuid(), ${new Date(now)}::timestamptz - ((n % 56 + 1) * interval '1 day') + (step * interval '6 seconds'),
          CASE WHEN step IN (0, 3) THEN 'page:view' WHEN step = 2 THEN 'cta:click' ELSE 'page:engagement' END,
          ('30000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
          ('40000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
          ('50000000-0000-4000-8000-' || lpad((n * 2 + CASE WHEN step >= 3 THEN 1 ELSE 0 END)::text, 12, '0'))::uuid,
          CASE WHEN step >= 3 THEN '/contact' ELSE '/project/rbc' END,
          CASE WHEN n % 2 = 0 THEN lpad(((n % 1199) + 1)::text, 16, 'A') END,
          CASE WHEN n % 3 = 0 THEN 'mobile' ELSE 'desktop' END,
          CASE WHEN step = 2 THEN '{"cta":"contact"}'::jsonb
               WHEN step IN (1,4) THEN '{"activeMs":5000,"maxScroll":80}'::jsonb ELSE '{}'::jsonb END
        FROM generate_series(1, 8000) n CROSS JOIN generate_series(0, 4) step`;
      await prisma.websiteEvent.create({ data: {
        id: "20000000-0000-4000-8000-000000000002", occurredAt: new Date(now - 30_000), kind: "link:open",
        path: `/r/${firstCode}/github`, linkCode: firstCode, props: { method: "HEAD", key: "github" },
      } });
      await prisma.$executeRaw`ANALYZE website_event`;

      async function measure<T>(label: string, read: () => Promise<T>) {
        const times: number[] = [];
        let result: T | undefined;
        for (let n = 0; n < 4; n++) {
          const before = queries;
          const start = performance.now();
          result = await read();
          times.push(performance.now() - start);
          expect(queries - before).toBe(1);
        }
        const warm = times.slice(1).sort((a, b) => a - b);
        console.info(`${label}: first ${times[0].toFixed(1)} ms, warm median ${warm[1].toFixed(1)} ms, one SQL request`);
        return result!;
      }
      const website = websiteReportOutput.parse(await measure("Website report (90 days)", () => loadWebsiteReport(reader, owner.id, { range: 90 }, now)));
      expect(website).toMatchObject({ excludedScanners: 1, totals: { visitors: 8000, previousVisitors: 0 } });
      expect(website.inquiries).toEqual([expect.objectContaining({ id: inquiry, channel: "other", status: "new" })]);
      expect(website.inquiries[0]).not.toHaveProperty("message");
      const jobs = jobSearchReportOutput.parse(await measure("Job Search report", () => loadJobSearchReport(reader, owner.id, now)));
      expect(jobs.shares).toEqual([{ code: "Share123", title: "Fixture share", track: "client", archived: false, opens: 0, visits: 0 }]);
      expect(jobs.applications).toHaveLength(1200);
      expect(jobs.excludedScanners).toBe(1);
      expect(jobs.applications.find(app => app.code === firstCode)).toMatchObject({ company: "Jobs company", role: "Jobs title",
        sentAt: "2026-09-01T18:00:00.000Z", outcome: "rejected",
        visits: expect.arrayContaining([expect.objectContaining({ scanner: true, link: "GitHub" })]),
      });
      expect(jobs.applications.find(app => app.code === zeroCode)).toMatchObject({ sentAt: null, outcome: "none", visits: [] });
      expect(jobs.applications.find(app => app.code === interviewCode)?.outcome).toBe("none");

      let reportNow = now;
      const app = createApp({
        emitAccessLog: () => {},
        resolveAccessContext: async () => ({ owner, client: { id: owner.id, name: owner.name, kind: "web" }, permissions: ["jobs:write"] }),
        websiteAnalyticsReports: {
          website: (ownerId, query) => loadWebsiteReport(reader, ownerId, query, now),
          jobSearch: ownerId => loadJobSearchReport(reader, ownerId, reportNow),
        },
      });
      const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost").origin;
      const transition = await app.request(`/api/v1/jobs/applications/${interviewId}`, {
        method: "PATCH", headers: { origin, "content-type": "application/json", "idempotency-key": "report-interview-fixture" },
        body: JSON.stringify({ status: "interviewing", expectedRevision: 0 }),
      });
      expect(transition.status).toBe(200);
      expect(await transition.json()).toMatchObject({ application: { status: "interviewing" }, revision: 1 });

      const beforeReport = queries;
      const jobReport = await app.request("/api/v1/website-analytics/job-search");
      expect(jobReport.status).toBe(200);
      expect(queries - beforeReport).toBe(1);
      const updated = jobSearchReportOutput.parse(await jobReport.json());
      expect(updated.applications.find(row => row.code === interviewCode)).toMatchObject({
        applicationId: interviewId, outcome: "interview", outcomeAt: null, sentAt: "2026-09-01T18:00:00.000Z",
      });
      for (const code of [firstCode, zeroCode]) {
        expect(updated.applications.find(row => row.code === code)).toEqual(jobs.applications.find(row => row.code === code));
      }

      const sharePath = "/api/v1/website-analytics/shares";
      const shareKey = "10000000-0000-4000-8000-000000007777";
      const createShare = (title: string) => app.request(sharePath, {
        method: "POST", headers: { origin, "content-type": "application/json", "idempotency-key": shareKey },
        body: JSON.stringify({ title, track: "frontend" }),
      });
      const created = await createShare("LinkedIn fixture");
      expect(created.status).toBe(201);
      const share = websiteShare.parse(await created.json());
      expect(share).toMatchObject({ title: "LinkedIn fixture", track: "frontend", archived: false });
      expect(await (await createShare("LinkedIn fixture")).json()).toEqual(share);
      expect((await createShare("Different title")).status).toBe(409);

      const archive = (code: string) => app.request(`${sharePath}/${code}`, { method: "DELETE", headers: { origin } });
      expect((await archive(share.code)).status).toBe(204);
      expect((await archive(share.code)).status).toBe(204);
      expect((await archive(firstCode)).status).toBe(204);
      expect(await lookupTrackedLink(share.code)).toEqual({ code: share.code, kind: "share", track: "frontend" });
      expect((await prisma.trackedLink.findUniqueOrThrow({ where: { code: firstCode } })).archivedAt).toBeNull();
      reportNow = Date.now() + 1000;
      const archivedReport = await app.request("/api/v1/website-analytics/job-search");
      expect(jobSearchReportOutput.parse(await archivedReport.json()).shares).toContainEqual({ ...share, archived: true });

      const saved = await app.request(`/api/v1/website-analytics/inquiries/${inquiry}`, {
        method: "PATCH", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ status: "replied" }),
      });
      expect(saved.status).toBe(200);
      const report = await app.request("/api/v1/website-analytics/website?range=7");
      expect(report.status).toBe(200);
      expect(websiteReportOutput.parse(await report.json()).inquiries).toEqual([expect.objectContaining({ id: inquiry, status: "replied" })]);
    } finally {
      await prisma.$disconnect();
    }
  },
  30_000,
);
