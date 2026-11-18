import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import type { PrismaClient } from "@quantself/db/generated/prisma/client";
import { resumeHeader } from "../../../scripts/jobs/resume-document";
import { jobsWorkClaimOutput, jobsWorkerPath } from "./jobs-work-contract";

const resumeMarkdown = `${resumeHeader}## Summary\n\n- Edited product pages\n\n## Experience\n\n- Maintained a product catalog\n`;

test.skipIf(process.env.QUANTSELF_JOBS_FEED_FIXTURE !== "1")(
  "concurrent Greenhouse imports queue one draft and WWR claims exclude unverified descriptions",
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/jobs_feed_fixture") {
      throw new Error("Use a disposable Docker jobs_feed_fixture database.");
    }
    const [{ prisma }, { createApp }] = await Promise.all([import("@quantself/db"), import("./app")]);
    const owner = { id: randomUUID(), name: "Fixture", email: "jobs-feed-fixture@example.test" };
    const bothInserting = Promise.withResolvers<void>();
    const codex = "x".repeat(32);
    let inserts = 0, applicationLookups = 0, identityLookups = 0;
    const db = prisma.$extends({ query: {
      jobApplication: {
        async findMany({ args, query }) {
          applicationLookups++;
          return query(args);
        },
      },
      jobProviderPosting: {
        async findMany({ args, query }) {
          identityLookups++;
          return query(args);
        },
        async createMany({ args, query }) {
          if (Array.isArray(args.data) && args.data.some(row => row.sourceIdentity === "greenhouse:global:fixture:1234")) {
            if (++inserts === 2) bothInserting.resolve();
            await bothInserting.promise;
          }
          return query(args);
        },
      },
    } });
    const app = createApp({
      emitAccessLog() {},
      resolveAccessContext: async () => ({
        owner, client: { id: owner.id, kind: "api-key", name: "Fixture feed" }, permissions: ["jobs:write"],
      }),
      jobsWorkers: { db: db as unknown as PrismaClient, secrets: () => ({ codex, runner: undefined }) },
    });
    const baseRow = { company: "Fixture", role: "Editor", track: "web", postingText: "Edit public product pages.", resumeMarkdown };
    const sourceIdentity = "greenhouse:global:fixture:1234";
    const rows = [
      { ...baseRow, sourceIdentity, sourceUrl: "https://careers.example.test/edit?gh_jid=1234" },
      { ...baseRow, sourceIdentity, sourceUrl: "https://jobs.example.test/new-editor?gh_jid=1234" },
    ];
    const send = async (key: string, ...applications: unknown[]) => app.request("/api/v1/jobs/applications/import", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ applications }),
    });
    async function result(response: Response) {
      expect(response.status).toBe(200);
      return response.json() as Promise<{ imported: number; duplicates: number }>;
    }
    const raceGuard = setTimeout(() => bothInserting.reject(new Error("Both imports must reach the identity insert.")), 3_000);
    try {
      await prisma.user.create({ data: owner });
      await prisma.authOwner.create({ data: { id: "singleton", userId: owner.id } });
      const raceStarted = performance.now();
      const responses = await Promise.all(rows.map((row, index) => send(`race-${index}`, row).then(result)));
      const raceMs = performance.now() - raceStarted;
      clearTimeout(raceGuard);
      expect(inserts).toBe(2);
      const winner = responses.findIndex(response => response.imported === 1);
      expect(winner).toBeGreaterThanOrEqual(0);
      expect(responses[1 - winner]).toEqual({ imported: 0, duplicates: 1 });
      const [saved] = await prisma.jobApplication.findMany({ where: { ownerId: owner.id } });
      expect(saved.sourceUrl).toBe(rows[winner].sourceUrl);
      expect(saved.applicationAddress).toMatch(/^luigi\.[a-z2-9]{4}@luigigirke\.com$/);
      expect(await Promise.all(rows.map((row, index) => send(`race-${index}`, row).then(result)))).toEqual(responses);
      expect(await result(await send("fresh-run", { ...rows[0], sourceUrl: "https://third.example.test/editor" })))
        .toEqual({ imported: 0, duplicates: 1 });
      const before = [applicationLookups, identityLookups];
      const repeated = Array.from({ length: 100 }, (_, index) => ({
        ...rows[0], sourceUrl: `https://another.example.test/editor-${index}`,
      }));
      const repeatStarted = performance.now();
      expect(await result(await send("batch-repeat", ...repeated))).toEqual({ imported: 0, duplicates: 100 });
      const repeatMs = performance.now() - repeatStarted;
      expect([applicationLookups, identityLookups]).toEqual(before.map(count => count + 1));
      expect(inserts).toBe(2);
      console.info(`First concurrent HTTP pair: ${raceMs.toFixed(1)} ms. Warm 100-row duplicate batch: ${repeatMs.toFixed(1)} ms, two bulk lookups.`);
      expect(await prisma.jobApplication.findMany({ where: { ownerId: owner.id } })).toEqual([saved]);
      expect(await prisma.jobProviderPosting.findMany({ where: { ownerId: owner.id } }))
        .toEqual([{ ownerId: owner.id, sourceIdentity, applicationId: saved.id }]);
      expect(await prisma.jobWorkItem.findMany({ where: { ownerId: owner.id }, select: { applicationId: true, kind: true, revision: true, state: true } }))
        .toEqual([{ applicationId: saved.id, kind: "enrich", revision: 0, state: "queued" }]);

      const legacy = { ...baseRow, sourceUrl: "https://boards.greenhouse.io/fixture/jobs/5678" };
      expect(await result(await send("legacy", legacy))).toEqual({ imported: 1, duplicates: 0 });
      expect(await result(await send("adopt", { ...legacy, sourceUrl: "https://careers.example.test/legacy?gh_jid=5678",
        sourceIdentity: "greenhouse:global:fixture:5678" }))).toEqual({ imported: 0, duplicates: 1 });
      expect((await send("conflict", { ...legacy, sourceIdentity: "greenhouse:global:fixture:1234" })).status).toBe(400);
      const unrelated = { ...baseRow, sourceUrl: "https://careers.example.test/unrelated" };
      expect(await result(await send("unrelated", unrelated))).toEqual({ imported: 1, duplicates: 0 });
      expect((await send("split", { ...unrelated, sourceIdentity })).status).toBe(409);
      expect(await result(await send("adopt-exact", { ...unrelated, sourceIdentity: "greenhouse:global:fixture:9101" })))
        .toEqual({ imported: 0, duplicates: 1 });

      const sourceUrl = "https://weworkremotely.com/remote-jobs/fixture-editor";
      expect(await result(await send("wwr", { ...baseRow, sourceUrl, postingText: "UNVERIFIED_IMPORT_CONTACTS" })))
        .toEqual({ imported: 1, duplicates: 0 });
      const claimed = [];
      for (let index = 0; index < 4; index++) {
        const response = await app.request(jobsWorkerPath + "/work/claim", {
          method: "POST", headers: { Authorization: `Bearer ${codex}`, "Content-Type": "application/json" },
          body: JSON.stringify({ workerId: "fixture", kinds: ["enrich"] }),
        });
        expect(response.status).toBe(200);
        claimed.push(jobsWorkClaimOutput.parse(await response.json()).work);
      }
      expect(claimed.find(work => work?.applicationId === saved.id)).toMatchObject({ input: { postingText: baseRow.postingText } });
      expect(claimed).toContainEqual(expect.objectContaining({ kind: "enrich", input: {
        candidateContext: "", track: "web", postingText: "", publicPosting: { sourceUrl, role: "Editor" },
      } }));
      expect(JSON.stringify(claimed)).not.toContain("UNVERIFIED_IMPORT_CONTACTS");
    } finally {
      clearTimeout(raceGuard);
      await prisma.$disconnect();
    }
  },
  15_000,
);
