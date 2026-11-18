import type { AccessContext } from "@quantself/auth";
import { expect, test } from "bun:test";
import { createApp } from "./app";
import { getOpenAPIDocument } from "./openapi";
import { jobSearchReportOutput, websiteReportOutput } from "./website-analytics-report-contract";
import type { WebsiteAnalyticsReportReaders } from "./website-analytics-report-route";
import { buildWebsiteReport } from "./website-analytics-reports";
import { buildJobSearchReport } from "./website-analytics-job-search";

const websitePath = "/api/v1/website-analytics/website";
const jobSearchPath = "/api/v1/website-analytics/job-search";
const owner = { id: "owner-id", email: "owner@example.test", name: "Owner" };
const now = Date.parse("2026-11-14T18:00:00Z");

function api(readers: Partial<WebsiteAnalyticsReportReaders> = {}) {
  return createApp({
    emitAccessLog: () => {},
    resolveAccessContext: async headers => {
      const kind = headers.get("x-test-client");
      if (kind !== "web" && kind !== "api-key" && kind !== "agent") return null;
      const client: AccessContext["client"] = { id: "client-id", name: "Fixture client", kind, avatar: null };
      return { client, owner, permissions: ["jobs:read", "jobs:write"] };
    },
    websiteAnalyticsReports: readers,
  });
}

test("Analytics reads and share mutations reject anonymous, API-key and Agent requests", async () => {
  let reads = 0;
  const unexpected = async () => { reads++; throw new Error("unexpected read"); };
  const app = api({ website: unexpected, jobSearch: unexpected });
  for (const [method, path] of [
    ["GET", websitePath], ["GET", jobSearchPath],
    ["POST", "/api/v1/website-analytics/shares"], ["DELETE", "/api/v1/website-analytics/shares/Share123"],
  ]) {
    expect((await app.request(path, { method })).status).toBe(401);
    for (const kind of ["api-key", "agent"]) {
      const response = await app.request(path, { method, headers: { "x-test-client": kind } });
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  }
  expect(reads).toBe(0);
});

test("Website route validates filters and publishes the generated Owner-only response shape", async () => {
  const calls: unknown[] = [];
  const app = api({ website: async (ownerId, query) => {
    calls.push({ ownerId, query });
    return buildWebsiteReport({ events: [], links: [], inquiries: [] }, query, now);
  } });
  const headers = { "x-test-client": "web" };
  const response = await app.request(`${websitePath}?range=90&channel=linkedin&project=%2Fproject%2Fexample&device=mobile`, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const report = websiteReportOutput.parse(await response.json());
  expect(report.range.days).toBe(90);
  expect(report.daily).toHaveLength(90);
  expect(report.totals.previousVisitors).toBe(0);
  expect(calls).toEqual([{ ownerId: owner.id, query: { range: 90, channel: "linkedin", project: "/project/example", device: "mobile" } }]);
  expect((await app.request(`${websitePath}?range=4`, { headers })).status).toBe(400);
  expect(calls).toHaveLength(1);
  const operation = getOpenAPIDocument(app).paths?.[websitePath]?.get;
  expect(operation?.security).toEqual([{ ownerSession: [] }]);
  expect(operation?.operationId).toBe("getWebsiteAnalyticsReport");
});

test("Job Search publishes the generated Owner-only response with an unsent zero-activity application", async () => {
  const calls: string[] = [];
  const app = api({ jobSearch: async ownerId => {
    calls.push(ownerId);
    return buildJobSearchReport([], [{ applicationId: "49db114d-041b-4e68-a82c-2050a3a47ac5", code: "MixedCaseCode123",
      cohort: "web-cms", company: "Registry company", role: "Registry role", status: null, sentAt: null }], now);
  } });
  const response = await app.request(jobSearchPath, { headers: { "x-test-client": "web" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(calls).toEqual([owner.id]);
  expect(jobSearchReportOutput.parse(await response.json())).toMatchObject({ applications: [{ sentAt: null, outcome: "none", visits: [] }] });
  const operation = getOpenAPIDocument(app).paths?.[jobSearchPath]?.get;
  expect(operation?.security).toEqual([{ ownerSession: [] }]);
  expect(operation?.operationId).toBe("getJobSearchAnalyticsReport");
});

test("Report backend failures return a safe status and private cache policy", async () => {
  const unavailable = async () => { throw new Error("fixture-secret"); };
  const app = api({ website: unavailable, jobSearch: unavailable });
  for (const path of [websitePath, jobSearchPath]) {
    const response = await app.request(path, { headers: { "x-test-client": "web" } });
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "ANALYTICS_UNAVAILABLE", message: "Website analytics is unavailable." });
  }
});
