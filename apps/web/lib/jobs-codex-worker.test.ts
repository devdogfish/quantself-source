import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobsWorkClient, type CodexWork } from "../../../scripts/jobs/work-client";
import { createJobsWorkOutbox } from "../../../scripts/jobs/work-outbox";
import { runJobsCodexBatch } from "./jobs-codex-worker";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const leaseToken = "synthetic-lease-token-123";
const common = { revision: 1, leaseToken, leaseUntil: "2040-01-01T00:10:00.000Z", applicationId: id(99) };
const modelInput = { track: "web" as const, candidateContext: "Synthetic candidate context." };
const brief = {
  doing: "Publish sample content.", remote: "confirmed" as const,
  automatable: "medium" as const, companySize: { people: null, label: "Unknown" },
  humanContact: { level: "low" as const, note: "Async project updates" },
  meetings: { level: "rare" as const, note: "Occasional planning call" },
};
const work: CodexWork[] = [
  { ...common, id: id(1), kind: "enrich", input: { ...modelInput, postingText: "A synthetic posting for an editor who maintains a public website." } },
  { ...common, id: id(2), kind: "tailor", input: { ...modelInput, resumeMarkdown: "Synthetic résumé.",
    brief: { ...brief, pay: { hourlyCad: null, original: null, converted: false } } } },
  { ...common, id: id(3), kind: "revise", input: { ...modelInput, resumeMarkdown: "Synthetic résumé.",
    brief: { ...brief, pay: { hourlyCad: null, original: null, converted: false } },
    summaryMarkdown: "- Initial summary", instructions: "Make it specific." } },
  { ...common, id: id(4), kind: "enrich", input: { ...modelInput, postingText: "A synthetic rate-limited posting." } },
];

test("the Codex worker validates enrichment and tailoring and stops claiming at the plan limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qs-jobs-model-test-"));
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let claimed = 0;
  const api = createJobsWorkClient({ baseUrl: "http://api:3001", secret: "synthetic-worker-key",
    fetchImpl: (async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-worker-key");
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body));
      requests.push({ path, body });
      return Response.json(path.endsWith("/claim") ? { work: work[claimed++] ?? null } : { accepted: true });
    }) as typeof fetch,
  });
  try {
    const totals = await runJobsCodexBatch({ api, outbox: createJobsWorkOutbox(directory, api), workerId: "fake-codex",
      now: () => Date.parse("2040-01-01T00:00:00Z"),
      runModel: async ({ prompt, outputSchema, signal }) => {
        expect(signal.aborted).toBe(false);
        expect(outputSchema).toMatchObject({ additionalProperties: false });
        if (prompt.includes("synthetic rate-limited posting")) throw new Error("429 usage limit");
        if (prompt.includes("A synthetic posting")) return JSON.stringify({ ...brief,
          pay: { min: 30, max: 45, currency: "CAD", period: "hour" }, eligible: true, verdict: "review", dueDate: null });
        if (prompt.includes("Make it specific")) {
          expect(prompt).toContain("- Initial summary");
          return JSON.stringify({ summaryMarkdown: "- Published accessible content\n- Improved page consistency\n- Kept launch schedules current" });
        }
        return JSON.stringify({ summaryMarkdown: "- Published sample content\n- Improved consistency\n- Kept schedules current" });
      },
    });
    expect(totals).toEqual({ claimed: 4, completed: 3, failed: 1, rateLimited: true });
    expect(requests.map(({ path }) => path.split("/").pop())).toEqual([
      "claim", "complete", "claim", "complete", "claim", "complete", "claim", "fail",
    ]);
    expect(requests[0].body).toEqual({ workerId: "fake-codex", kinds: ["enrich", "tailor", "revise"] });
    expect(requests[1].body).toMatchObject({ result: { doing: brief.doing, pay: { min: 30, max: 45, currency: "CAD", period: "hour" } } });
    expect(requests[5].body).toMatchObject({ result: { summaryMarkdown: expect.stringContaining("Published accessible content") } });
    expect(requests[7].body).toMatchObject({ leaseToken, code: "rate_limited" });
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a lost failure acknowledgement replays its durable result without rerunning the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qs-jobs-model-replay-"));
  const messages: string[] = [];
  let first = true;
  let claimed = 0;
  let modelCalls = 0;
  const api = createJobsWorkClient({ baseUrl: "http://api:3001", secret: "synthetic-worker-key",
    fetchImpl: (async (url, init) => {
      if (String(url).endsWith("/claim")) return Response.json({ work: claimed++ === 0 ? work[1] : null });
      messages.push(String(init?.body));
      if (first) { first = false; throw new Error("synthetic network loss"); }
      return Response.json({ accepted: true });
    }) as typeof fetch,
  });
  try {
    const run = () => runJobsCodexBatch({ api, outbox: createJobsWorkOutbox(directory, api), workerId: "fake-codex",
      now: () => Date.parse("2040-01-01T00:00:00Z"),
      runModel: async () => { modelCalls++; return "{ synthetically-invalid"; },
    });
    await expect(run()).rejects.toThrow("jobs_work_api_unavailable");
    expect(await readdir(directory)).toEqual([`${JSON.parse(messages[0]).resultId}.json`]);
    await run();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toBe(messages[0]);
    expect(JSON.parse(messages[0]).code).toBe("model_error");
    expect(modelCalls).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("enrichment uses the exact WWR posting and falls back at snapshot expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qs-jobs-wwr-worker-"));
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const sourceUrl = "https://weworkremotely.com/remote-jobs/fixture-editor";
  const otherPosting = `<item><link>${sourceUrl}-other</link><description>UNRELATED_POSTING provides customer support and coordinates sales coverage for multiple departments and an international marketing team.</description></item>`;
  const responsibilities = "Update public documentation, verify accessibility, maintain release notes, and collaborate with a remote product team on publishing.";
  const matching = `<item><link>${sourceUrl}?utm_source=rss</link><description><![CDATA[<p>${responsibilities} recruiter@example.org +1 (555) 234-5678</p>]]></description></item>`;
  const prompts: Record<string, unknown>[] = [];
  let at = Date.parse("2040-01-01T00:00:00Z");
  let fetches = 0, claimed = 0;
  Date.now = () => at;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    expect(String(input)).toBe("https://weworkremotely.com/remote-jobs.rss");
    expect(options).toMatchObject({ redirect: "error", credentials: "omit" });
    const headers = new Headers(options?.headers);
    expect(["authorization", "x-api-key", "cookie"].some(name => headers.has(name))).toBe(false);
    const items = ++fetches === 1 ? otherPosting + matching : otherPosting;
    return new Response(`<rss version="2.0"><channel>${items}</channel></rss>`, { headers: { "content-type": "application/rss+xml" } });
  }, { preconnect: originalFetch.preconnect });
  const api = createJobsWorkClient({ baseUrl: "http://api:3001", secret: "synthetic-worker-key",
    fetchImpl: (async (url) => Response.json(String(url).endsWith("/claim") ? { work: claimed < 3 ? {
      ...common, id: id(++claimed), kind: "enrich", input: {
        ...modelInput, postingText: "UNVERIFIED_STORED_DESCRIPTION", publicPosting: { sourceUrl, role: "Documentation editor" },
      },
    } : null } : { accepted: true })) as typeof fetch,
  });
  try {
    const totals = await runJobsCodexBatch({ api, outbox: createJobsWorkOutbox(directory, api), workerId: "fake-codex",
      runModel: async ({ prompt }) => {
        prompts.push(JSON.parse(prompt.split("\n\n").at(-1)!));
        at += prompts.length === 1 ? 119_999 : 1;
        return JSON.stringify({ ...brief, pay: null, eligible: true, verdict: "review", dueDate: null });
      },
    });
    expect(totals).toMatchObject({ claimed: 3, completed: 3 });
    expect(fetches).toBe(2);
    expect(prompts.slice(0, 2)).toEqual(Array(2).fill({ ...modelInput, postingText: responsibilities + " [contact omitted] [contact omitted]" }));
    expect(prompts[2]).toMatchObject({ ...modelInput, postingText: expect.stringContaining("Use only the supplied role title and approved candidate facts."),
      role: "Documentation editor" });
    expect(JSON.stringify(prompts)).not.toMatch(/UNVERIFIED_STORED_DESCRIPTION|UNRELATED_POSTING|recruiter@example.org|234-5678|weworkremotely.com/);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    await rm(directory, { recursive: true, force: true });
  }
});
