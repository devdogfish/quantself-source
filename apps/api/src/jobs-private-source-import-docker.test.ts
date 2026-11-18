import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { resumeHeader } from "../../../scripts/jobs/resume-document";

const archivedKey = createHash("sha256").update("careers.example.test/job?gh_jid=1234").digest("hex");
const historicalUrl = "https://jobs.example.test/job?gh_jid=1234";
const canonicalUrl = "https://careers.example.test/job?gh_jid=1234";
const rule = { canonicalHost: "careers.example.test", aliases: ["jobs.example.test"], path: "/job", postingIdParameter: "gh_jid" };

test.skipIf(process.env.QUANTSELF_JOBS_PRIVATE_SOURCE_FIXTURE !== "1")(
  "private source rules reuse archived keys and stop import when the file is unsafe",
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/jobs_private_source_fixture") {
      throw new Error("Use a fresh disposable Docker Jobs source fixture database.");
    }
    const [{ prisma }, { createApp }] = await Promise.all([import("@quantself/db"), import("./app")]);
    const directory = await mkdtemp(join(tmpdir(), "qs-jobs-rules-"));
    const privateFile = join(directory, "rules.json");
    const previous = process.env.QUANTSELF_JOBS_PRIVATE_SOURCE_RULES_FILE;
    const owner = { id: randomUUID(), name: "Fixture", email: "fixture@example.test" };
    const app = createApp({
      emitAccessLog() {},
      resolveAccessContext: async headers => {
        const importOnly = headers.get("x-fixture-scope") === "import";
        return { owner, client: { id: importOnly ? owner.id + ":feed" : owner.id, name: "Fixture client", kind: "api-key" },
          permissions: [importOnly ? "jobs:import-tailored" : "jobs:write"] };
      },
    });
    const posting = { company: "Fixture studio", role: "Editor", track: "web", postingText: "Maintain product pages.",
      resumeMarkdown: resumeHeader + "## Summary\n\n- Edited product pages\n" };
    const send = (sourceUrl: string, key: string, batch = true) => {
      const row = { ...posting, sourceUrl };
      return app.request("/api/v1/jobs/applications" + (batch ? "/import" : ""), {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(batch ? { applications: [row] } : row),
      });
    };
    const importProvider = (sourceUrl: string, command: string) => app.request("/api/v1/jobs/applications/import", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": command, "x-fixture-scope": "import" },
      body: JSON.stringify({ applications: [{ sourceUrl, company: posting.company, role: posting.role, track: posting.track,
        postingText: posting.postingText, sourceIdentity: "greenhouse:global:fixture:1234" }] }),
    });
    try {
      await writeFile(privateFile, JSON.stringify({ version: 1, rules: [rule] }), { mode: 0o600 });
      process.env.QUANTSELF_JOBS_PRIVATE_SOURCE_RULES_FILE = privateFile;
      const archived = await prisma.jobApplication.create({ data: {
        ownerId: owner.id, sourceKey: archivedKey, sourceUrl: historicalUrl, company: "Archived studio", role: "Editor",
        resumeTrack: "web", status: "applied", appliedAt: new Date("2026-01-01T00:00:00Z"), revision: 4, approvedRevision: 4,
      } });
      const first = await send(historicalUrl, "archive-batch");
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ imported: 0, duplicates: 1 });
      const replay = await send(historicalUrl, "archive-batch");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ imported: 0, duplicates: 1 });
      const added = await send(historicalUrl, "archive-single", false);
      expect(added.status).toBe(200);
      expect(await added.json()).toMatchObject({ duplicate: true, application: { id: archived.id, status: "applied" } });
      expect(await prisma.jobApplication.findUnique({ where: { ownerId_id: { ownerId: owner.id, id: archived.id } } })).toEqual(archived);
      expect(await prisma.jobWorkItem.count({ where: { ownerId: owner.id } })).toBe(0);

      for (const [sourceUrl, command] of [
        [historicalUrl, "bind-archive"], [historicalUrl, "bind-archive"],
        ["https://new.example.test/editor?gh_jid=1234", "moved-archive"],
      ]) {
        const duplicate = await importProvider(sourceUrl, command);
        expect(duplicate.status).toBe(200);
        expect(await duplicate.json()).toEqual({ imported: 0, duplicates: 1 });
      }
      expect(await prisma.jobProviderPosting.findMany({ where: { ownerId: owner.id } })).toEqual([
        { sourceIdentity: "greenhouse:global:fixture:1234", ownerId: owner.id, applicationId: archived.id },
      ]);
      expect(await prisma.jobApplication.findUnique({ where: { ownerId_id: { ownerId: owner.id, id: archived.id } } })).toEqual(archived);

      const symlinkPath = join(directory, "alias.json");
      await symlink(privateFile, symlinkPath);
      for (const path of [symlinkPath, join(directory, "missing.json")]) {
        process.env.QUANTSELF_JOBS_PRIVATE_SOURCE_RULES_FILE = path;
        const denied = await send(canonicalUrl, "unsafe-file-" + randomUUID());
        expect(denied.status).toBe(503);
        expect(await denied.json()).toEqual({ message: "Private Jobs source rules are unavailable or invalid." });
      }
      process.env.QUANTSELF_JOBS_PRIVATE_SOURCE_RULES_FILE = privateFile;
      await chmod(privateFile, 0o644);
      expect((await send(canonicalUrl, "readable-file")).status).toBe(503);
      await chmod(privateFile, 0o600);
      await writeFile(privateFile, JSON.stringify({ version: 1, rules: [rule, rule] }));
      expect((await send(canonicalUrl, "ambiguous-rule")).status).toBe(503);
      expect(await prisma.jobApplication.count({ where: { ownerId: owner.id } })).toBe(1);
      expect(await prisma.jobWorkItem.count({ where: { ownerId: owner.id } })).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.QUANTSELF_JOBS_PRIVATE_SOURCE_RULES_FILE;
      else process.env.QUANTSELF_JOBS_PRIVATE_SOURCE_RULES_FILE = previous;
      await rm(directory, { recursive: true, force: true });
      await prisma.$disconnect();
    }
  },
  15_000,
);
