import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateRules, experiencePosting, screeningPosting } from "../../../../../../../scripts/jobs/candidate-rules.fixture";
import { GET } from "./route";

test("reads one Owner-scoped application and returns only projected rules, with a usable redacted fallback", async () => {
  const home = await mkdtemp(join(tmpdir(), "jobs-candidate-display-"));
  const previousHome = process.env.QUANTSELF_JOBS_HOME;
  const originalFetch = globalThis.fetch;
  const id = "00000000-0000-4000-8000-000000000001";
  const params = Promise.resolve({ id });
  const rulesPath = join(home, "candidate-rules.json");
  const request = new Request(`http://localhost/api/jobs/application-details/${id}`, {
    headers: { cookie: "synthetic-owner-session", "x-api-key": "unused-fixture" },
  });
  process.env.QUANTSELF_JOBS_HOME = home;
  let calls = 0;
  let accepted = true;
  let application = { id, ...screeningPosting, track: "web", summaryMarkdown: "Omitted application snapshot" };
  globalThis.fetch = (async (url, config) => {
    calls++;
    expect(String(url)).toEndWith(`/api/v1/jobs/applications/${id}`);
    expect(new Headers(config?.headers).get("cookie")).toBe("synthetic-owner-session");
    expect(new Headers(config?.headers).has("x-api-key")).toBe(false);
    return accepted ? Response.json({ application }) : new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    await writeFile(rulesPath, JSON.stringify(candidateRules), { mode: 0o600 });
    const response = await GET(request, { params });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.application).toEqual({ ...screeningPosting, resumeTrack: "web" });
    expect(body.candidateRules.rules).toHaveLength(candidateRules[0].rules.length);
    expect(body.candidateRules.rules.some((rule: { hasResumeOnlyDefault?: boolean }) => rule.hasResumeOnlyDefault)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(experiencePosting.company);
    expect(JSON.stringify(body)).not.toContain("resumeOnlyValue");
    expect(JSON.stringify(body)).not.toContain("pageIdentity");
    expect(body.candidateRules.rules[0]).not.toHaveProperty("id");
    expect(calls).toBe(1);

    await writeFile(rulesPath, "private malformed fixture");
    accepted = false;
    const denied = await GET(request, { params });
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe("");
    const badId = await GET(request, { params: Promise.resolve({ id: "invalid" }) });
    expect(badId.status).toBe(400);
    expect(calls).toBe(2);

    accepted = true;
    expect(await (await GET(request, { params })).json()).toEqual({
      application: { ...screeningPosting, resumeTrack: "web" }, candidateRulesUnavailable: true,
    });
    await writeFile(rulesPath, JSON.stringify(candidateRules));
    application = { ...application, sourceUrl: "https://example.test/new" };
    const unmatched = await (await GET(request, { params })).json();
    expect(unmatched).not.toHaveProperty("candidateRules");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.QUANTSELF_JOBS_HOME;
    else process.env.QUANTSELF_JOBS_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
