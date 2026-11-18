import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeHeader } from "../../../scripts/jobs/resume-document";
import { jobsWorkClaimOutput, jobsWorkerPath } from "./jobs-work-contract";

const feedKey = "synthetic-feed-test-key";
const cliKey = "synthetic-cli-test-key";
const worker = "c".repeat(32);
const posting = {
  sourceUrl: "https://example.test/feed/editor", company: "Fixture Studio", role: "Editor",
  track: "web", postingText: "Publish and maintain public product pages.",
};
const template = `${resumeHeader}## Summary\n\n- Edited product pages\n\n## Experience\n\n- Maintained product catalogs\n`;
const summaryMarkdown = "- Published product pages\n- Maintained catalog listings\n- Updated landing pages";

test.skipIf(process.env.QUANTSELF_JOBS_FEED_SCOPE_FIXTURE !== "1")(
  "an import-only key can replay draft intake and the separate worker enriches and tailors it",
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/jobs_feed_scope_fixture") {
      throw new Error("Use a disposable Docker jobs_feed_scope_fixture database.");
    }
    const [{ prisma }, { createApp }, { resolveAccessContext }] = await Promise.all([
      import("@quantself/db"), import("./app"), import("@quantself/auth"),
    ]);
    const directory = await mkdtemp(join(tmpdir(), "jobs-feed-scope-"));
    const proof = randomBytes(32).toString("hex");
    const origin = "http://localhost";
    const previousProof = process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
    const previousOrigin = process.env.QUANTSELF_PUBLIC_ORIGIN;
    const priorTemplates = process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
    const owner = { id: randomUUID(), name: "Fixture owner", email: "owner@example.test" };
    const app = createApp({
      emitAccessLog() {},
      resolveAccessContext: headers => resolveAccessContext(headers, {
        findOwnerByUserId: async id => id === owner.id ? { userId: id, user: owner } : null,
        findExistingOwner: async () => ({ userId: owner.id, user: owner }),
        verifyApiKey: async token => token === feedKey || token === cliKey ? {
          id: token === feedKey ? "fixture-feed" : "fixture-cli", name: "Fixture key", metadata: null, referenceId: owner.id,
          permissions: { jobs: token === feedKey ? ["import-tailored"] : ["write"] },
        } : null,
      }),
      jobsWorkers: { db: prisma, secrets: () => ({ codex: worker, runner: undefined }) },
    });
    const applications = "/api/v1/jobs/applications";
    function request(method: string, path: string, body: unknown, key: string, command: string = randomUUID()) {
      return app.request(path, {
        method, headers: { "x-api-key": key, "idempotency-key": command, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    const importBatch = (key: string, command: string, row: unknown = posting) =>
      request("POST", applications + "/import", { applications: [row] }, key, command);
    function workerRequest(path: string, body: unknown, token = worker) {
      return app.request(jobsWorkerPath + path, {
        method: "POST", headers: { authorization: `Bearer ${token}`, ...(token === feedKey && { "x-api-key": feedKey }), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    async function claim(kind: "enrich" | "tailor") {
      const response = await workerRequest("/work/claim", { workerId: "fixture", kinds: [kind] });
      expect(response.status).toBe(200);
      const { work } = jobsWorkClaimOutput.parse(await response.json());
      if (work?.kind !== kind) throw new Error(`Expected ${kind} claim.`);
      return work;
    }
    try {
      process.env.QUANTSELF_OWNER_INGRESS_TOKEN = proof;
      process.env.QUANTSELF_PUBLIC_ORIGIN = origin;
      process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = directory;
      await writeFile(join(directory, "web.md"), template);
      await prisma.user.create({ data: owner });
      await prisma.authOwner.create({ data: { id: "singleton", userId: owner.id } });

      const first = await importBatch(feedKey, "scope-fixture");
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ imported: 1, duplicates: 0 });
      const retry = await importBatch(feedKey, "scope-fixture");
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ imported: 1, duplicates: 0 });
      const cli = await importBatch(cliKey, "cli-keeps-working");
      expect(cli.status).toBe(200);
      expect(await cli.json()).toEqual({ imported: 0, duplicates: 1 });
      const ownerReplay = await app.request(applications + "/import", {
        method: "POST", headers: { origin,
          "x-quantself-owner-proof": proof, "idempotency-key": "owner-keeps-working", "content-type": "application/json" },
        body: JSON.stringify({ applications: [posting] }),
      });
      expect(ownerReplay.status).toBe(200);
      expect(await ownerReplay.json()).toEqual({ imported: 0, duplicates: 1 });
      expect((await importBatch(feedKey, "record-outcome", { ...posting, recordedStatus: "applied" })).status).toBe(403);
      expect((await importBatch(feedKey, "supply-resume", { ...posting, resumeMarkdown: template })).status).toBe(403);
      expect(await prisma.jobApplication.count({ where: { ownerId: owner.id } })).toBe(1);
      expect(await prisma.jobWorkItem.count({ where: { ownerId: owner.id, kind: "enrich" } })).toBe(1);

      const enrich = await claim("enrich");
      const id = enrich.applicationId;
      const detail = applications + "/" + id;
      expect((await request("POST", applications, posting, feedKey)).status).toBe(403);
      expect((await request("GET", detail, undefined, feedKey)).status).toBe(403);
      expect((await request("PATCH", detail, { expectedRevision: 0, summaryMarkdown }, feedKey)).status).toBe(403);
      expect((await request("POST", detail + "/decision", { action: "approve", expectedRevision: 0 }, feedKey)).status).toBe(403);
      expect((await workerRequest("/work/claim", { workerId: "fixture", kinds: ["enrich"] }, feedKey)).status).toBe(401);
      const enrichment = { resultId: randomUUID(), leaseToken: enrich.leaseToken, result: {
        eligible: true, doing: "Publish product pages.", remote: "not_stated", companySize: { people: null, label: "Unknown" },
        automatable: "medium", humanContact: { level: "low", note: "Async updates" },
        meetings: { level: "rare", note: "Planning" }, pay: null, verdict: "strong", dueDate: null,
      } };
      const enrichPath = `/work/${enrich.id}/complete`;
      expect((await workerRequest(enrichPath, enrichment, feedKey)).status).toBe(401);
      expect((await workerRequest(enrichPath, enrichment)).status).toBe(200);
      const tailor = await claim("tailor");
      expect(tailor.applicationId).toBe(id);
      expect(tailor.input).toMatchObject({ resumeMarkdown: template, brief: { doing: "Publish product pages." } });
      const result = { resultId: randomUUID(), leaseToken: tailor.leaseToken, result: { summaryMarkdown } };
      expect((await workerRequest(`/work/${tailor.id}/complete`, result)).status).toBe(200);
      expect(await prisma.jobApplication.findUnique({ where: { ownerId_id: { ownerId: owner.id, id } } }))
        .toMatchObject({ status: "review", revision: 1, summary: summaryMarkdown, approvedRevision: null });
      expect((await workerRequest(`/submissions/${id}/events`, {}, feedKey)).status).toBe(401);
    } finally {
      if (previousProof === undefined) delete process.env.QUANTSELF_OWNER_INGRESS_TOKEN;
      else process.env.QUANTSELF_OWNER_INGRESS_TOKEN = previousProof;
      if (previousOrigin === undefined) delete process.env.QUANTSELF_PUBLIC_ORIGIN;
      else process.env.QUANTSELF_PUBLIC_ORIGIN = previousOrigin;
      if (priorTemplates === undefined) delete process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR;
      else process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = priorTemplates;
      await rm(directory, { recursive: true, force: true });
      await prisma.$disconnect();
    }
  },
  15_000,
);
