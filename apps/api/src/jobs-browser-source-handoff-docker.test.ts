import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverForm } from "../../../scripts/jobs/browser";
import { directBrowserFixtures } from "../../../scripts/jobs/browser-direct.fixture";
import { resumeHeader } from "../../../scripts/jobs/resume-document";

test.skipIf(process.env.QUANTSELF_JOBS_BROWSER_HANDOFF_FIXTURE !== "1")(
  "a normalized imported posting reaches only its reviewed private browser target",
  async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/jobs_browser_handoff_fixture") {
      throw new Error("Use a disposable Docker Jobs browser handoff database.");
    }
    const [{ prisma }, { createApp }] = await Promise.all([import("@quantself/db"), import("./app")]);
    const directory = await mkdtemp(join(tmpdir(), "qs-jobs-browser-handoff-"));
    const rulesPath = join(directory, "source-rules.json");
    const profilesPath = join(directory, "direct-browser-targets.json");
    const browser = join(directory, "synthetic-browser");
    const savedEnvironment = {
      QUANTSELF_JOBS_HOME: process.env.QUANTSELF_JOBS_HOME,
      QUANTSELF_JOBS_PRIVATE_SOURCE_RULES_FILE: process.env.QUANTSELF_JOBS_PRIVATE_SOURCE_RULES_FILE,
      QUANTSELF_JOBS_RESUME_TEMPLATES_DIR: process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR,
    };
    const originalFetch = globalThis.fetch;
    const fixture = directBrowserFixtures.find(target => target.portal === "greenhouse")!;
    const listing = new URL(fixture.listingUrl);
    const alias = "www." + listing.hostname;
    const normalizedUrl = "https://" + alias + listing.pathname + listing.search;
    const landedUrl = "https://" + alias + listing.pathname + "/?utm_source=fixture&" + listing.search.slice(1);
    const sourceIdentity = "greenhouse:global:fixture-embedded:" + listing.searchParams.get("gh_jid");
    const owner = { id: randomUUID(), name: "Fixture", email: "fixture@example.test" };
    const app = createApp({
      emitAccessLog() {},
      resolveAccessContext: async () => ({
        owner, client: { id: owner.id, name: "Fixture feed", kind: "api-key" }, permissions: ["jobs:import-tailored"],
      }),
    });
    function importPosting(sourceUrl: string, command: string, provider?: string) {
      return app.request("/api/v1/jobs/applications/import", {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": command },
        body: JSON.stringify({ applications: [{ sourceUrl, company: fixture.company, role: fixture.role, track: "web",
          postingText: "Maintain a synthetic report.", ...(provider && { sourceIdentity: provider }) }] }),
      });
    }
    const cdpUrl = "http://127.0.0.1:45678";
    const browserOptions = { cdpUrl, browserUseCommand: browser, candidateRules: [] };
    const cdpRequests: string[] = [];
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      const request = String(input);
      cdpRequests.push(request);
      if (request !== cdpUrl + "/json/version") throw new Error("Unexpected fixture request.");
      return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:45678/devtools/browser/00000000-0000-4000-8000-000000000001" });
    }, { preconnect: originalFetch.preconnect });
    try {
      process.env.QUANTSELF_JOBS_HOME = directory;
      process.env.QUANTSELF_JOBS_PRIVATE_SOURCE_RULES_FILE = rulesPath;
      process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = directory;
      await Promise.all([
        writeFile(rulesPath, JSON.stringify({ version: 1, rules: [
          { canonicalHost: listing.hostname, aliases: [alias], path: listing.pathname, postingIdParameter: "gh_jid" },
        ] }), { mode: 0o600 }),
        writeFile(join(directory, "web.md"), resumeHeader + "## Summary\n\n- Maintained product reports\n", { mode: 0o600 }),
        writeFile(browser, `#!/usr/bin/env python3
import json, os, sys
if sys.argv[1:] == ["--reload"]:
    sys.exit(0)
params = json.loads(os.environ["QS_JOBS_BROWSER_INPUT"])
if (params.get("portal"), params.get("mode"), params.get("url"), params.get("listingUrl")) != (
    "greenhouse", "discover", ${JSON.stringify(fixture.url)}, ${JSON.stringify(fixture.listingUrl)}
):
    sys.exit(4)
print(json.dumps({"qsJobsBrowser":"discovered","fields":[]}, separators=(",",":")))
`, { mode: 0o700 }),
      ]);
      for (const [sourceUrl, command, provider, result] of [
        [landedUrl, "first", sourceIdentity, { imported: 1, duplicates: 0 }],
        [landedUrl, "first", sourceIdentity, { imported: 1, duplicates: 0 }],
        [fixture.listingUrl, "canonical", undefined, { imported: 0, duplicates: 1 }],
      ] as const) {
        const response = await importPosting(sourceUrl, command, provider);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(result);
      }
      const rows = await prisma.jobApplication.findMany({ where: { ownerId: owner.id } });
      expect(rows).toHaveLength(1);
      const [job] = rows;
      expect(job).toMatchObject({
        sourceUrl: normalizedUrl,
        sourceKey: createHash("sha256").update(listing.hostname + listing.pathname + listing.search).digest("hex"),
      });
      expect(await prisma.jobWorkItem.count({ where: { ownerId: owner.id, applicationId: job.id } })).toBe(1);
      const work = { sourceUrl: job.sourceUrl, company: job.company, role: job.role };
      const unsupported = { kind: "failed", code: "unsupported_portal" } as const;
      expect(await discoverForm(work, browserOptions)).toEqual(unsupported);
      await writeFile(profilesPath, JSON.stringify([fixture]), { mode: 0o600 });
      expect(await discoverForm(work, browserOptions)).toEqual(unsupported);
      await writeFile(profilesPath, JSON.stringify([{ ...fixture, sources: [...fixture.sources, normalizedUrl] }]));
      await chmod(profilesPath, 0o644);
      expect(await discoverForm(work, browserOptions)).toEqual(unsupported);
      await chmod(profilesPath, 0o600);
      expect(await discoverForm({ ...work, role: "Different fixture role" }, browserOptions))
        .toEqual({ kind: "failed", code: "identity_mismatch" });
      expect(cdpRequests).toEqual([]);
      expect(await discoverForm(work, browserOptions))
        .toEqual({ kind: "discovered", listingUrl: fixture.listingUrl, fields: [] });
      expect(cdpRequests).toEqual([cdpUrl + "/json/version"]);

      await chmod(rulesPath, 0o644);
      const invalid = await importPosting(landedUrl, "unsafe-config", sourceIdentity);
      expect(invalid.status).toBe(503);
      expect(await invalid.json()).toEqual({ message: "Private Jobs source rules are unavailable or invalid." });
      expect(await prisma.jobApplication.count({ where: { ownerId: owner.id } })).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(directory, { recursive: true, force: true });
      await prisma.$disconnect();
    }
  },
  15_000,
);
