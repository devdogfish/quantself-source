import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeHeader } from "../../../../scripts/jobs/resume-document";
import { runJobsMacOnce } from "../../../../scripts/jobs/run-jobs-mac-worker";
import { createJobsWorkClient } from "../../../../scripts/jobs/work-client";
import { createJobsWorkOutbox } from "../../../../scripts/jobs/work-outbox";

const database = new URL(process.env.DATABASE_URL ?? "");
assert.equal(process.env.QUANTSELF_JOBS_FEED_N8N_FIXTURE, "1");
assert.equal(database.protocol, "postgresql:");
assert.equal(database.hostname, "db");
assert.equal(database.pathname, "/jobs_feed_n8n_fixture");

const [{ prisma }, { createApp }, { createApiKey }] = await Promise.all([
  import("../../../../packages/db"),
  import("../../../../apps/api/src/app"),
  import("../../../../packages/auth/src/index"),
]);
const owner = { id: randomUUID(), name: "Synthetic Feed Owner", email: "feed-owner@example.test" };
const template = resumeHeader + "## Summary\n\n- Edited product pages\n\n## Experience\n\n- Maintained client records\n";
const summaryMarkdown = "- Prepared Excel reports\n- Maintained client records\n- Updated remote workbooks";
const directory = await mkdtemp(join(tmpdir(), "jobs-feed-templates-"));
await writeFile(join(directory, "admin.md"), template);
process.env.QUANTSELF_JOBS_RESUME_TEMPLATES_DIR = directory;

await prisma.$transaction(async tx => {
  await tx.user.create({ data: owner });
  await tx.authOwner.create({ data: { id: "singleton", userId: owner.id } });
});
const { credential, secret } = await createApiKey({
  userId: owner.id, name: "Disposable n8n feed", preset: "custom", permissionIds: ["jobs:import-tailored"],
  expiresAt: new Date(Date.now() + 10 * 60_000),
});
assert.deepEqual(credential.permissions, ["jobs:import-tailored"]);
const proof = randomBytes(32).toString("hex");
process.env.QUANTSELF_OWNER_INGRESS_TOKEN = proof;
const codex = randomBytes(24).toString("hex");
const runner = process.env.QUANTSELF_JOBS_FEED_PDF_FIXTURE === "1" ? randomBytes(24).toString("hex") : undefined;
const storedPdfs = new Map<string, Uint8Array>();
const app = createApp({
  emitAccessLog() {},
  jobsWorkers: {
    db: prisma, secrets: () => ({ codex, runner }),
    ...(runner && {
      pdfStore: {
        async put(key, bytes) {
          storedPdfs.set(key, Buffer.from(bytes));
          return key;
        },
        async open(key) {
          const bytes = storedPdfs.get(key);
          return new Response(bytes ? Buffer.from(bytes) : null, {
            status: bytes ? 200 : 404, headers: { "Content-Type": "application/pdf" },
          });
        },
      },
    }),
  },
});
const applicationsPath = "/api/v1/jobs/applications";
const origin = new URL(process.env.QUANTSELF_PUBLIC_ORIGIN!).origin;
const who = { ownerId: owner.id };
const loopback = "http://127.0.0.1:3001";
const workerCalls: { route: string; status: number; elapsedMs: number }[] = [];

async function verifyOwnerPdf(applicationId: string, revision: number, runnerKey: string) {
  assert.equal(process.env.QUANTSELF_JOBS_SUBMIT_DISABLED, "1");
  process.env.QUANTSELF_JOBS_HOME = directory;
  process.env.QUANTSELF_JOBS_PRIVATE_FIELDS_KEY = randomBytes(32).toString("base64url");
  const placeholder = "resume-fixture@example.test";
  const globalContact = "resume-global-fixture@example.test";
  const source = join(directory, "Synthetic-Admin-Resume.md");
  // The configured branded renderer expects this masthead text. The résumé content is generated here.
  await writeFile(source, "# Luigi Girke\n\n" + placeholder + "\n\n" + template.slice(resumeHeader.length), { mode: 0o600 });
  await writeFile(join(directory, "private.json"), JSON.stringify({
    resumePaths: { admin: source }, rendererPath: "/renderer/render_resumes.py",
    rendererPython: "/opt/jobs-python/bin/python",
  }), { mode: 0o600 });
  const productCalls: { method: string; path: string; status: number }[] = [];
  async function ownerRequest(path: string, method = "GET", body?: unknown) {
    const response = await fetch(loopback + path, {
      method, headers: { Origin: origin, "x-quantself-owner-proof": proof, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    productCalls.push({ method, path, status: response.status });
    return response;
  }
  const started = performance.now();
  const privateFields = await ownerRequest("/api/v1/jobs/private-fields", "PATCH", {
    fields: [{ key: "email", label: "Email", type: "email", scope: { kind: "global" }, value: globalContact, expectedVersion: null }],
  });
  assert.equal(privateFields.status, 200, "Seed the synthetic global contact");
  const path = applicationsPath + "/" + applicationId;
  assert.equal((await ownerRequest(path + "/resume.pdf?revision=" + revision)).status, 404);
  const approved = await ownerRequest(path + "/decision", "POST", { action: "approve", expectedRevision: revision });
  assert.equal(approved.status, 200);
  await approved.arrayBuffer();
  const api = createJobsWorkClient({ baseUrl: loopback, secret: runnerKey });
  const workerStart = workerCalls.length;
  const renderStarted = performance.now();
  assert(await runJobsMacOnce({
    api, workerId: "n8n-pdf-fixture", cdpUrl: "http://127.0.0.1:1", paused: true,
    outbox: createJobsWorkOutbox(join(directory, "render-outbox"), api),
  }));
  const renderMs = Math.round(performance.now() - renderStarted);
  const renderRequests = workerCalls.slice(workerStart);
  assert.equal(storedPdfs.size, 1, "The real renderer must upload one PDF");

  assert.equal((await ownerRequest(path + "/resume.pdf?revision=0")).status, 409);
  const preview = await ownerRequest(path + "/resume.pdf?revision=" + revision);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("Content-Type"), "application/pdf");
  const bytes = Buffer.from(await preview.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  const current = await prisma.jobApplication.findUniqueOrThrow({ where: { ownerId_id: { ...who, id: applicationId } } });
  const selected = await prisma.jobRevision.findUniqueOrThrow({
    where: { ownerId_applicationId_revision: { ...who, applicationId, revision } },
  });
  assert.equal(current.approvedRevision, revision);
  assert.equal(current.approvedPreviewDigest, digest);
  assert.equal(selected.pdfSha256, digest);
  assert.equal(current.receipt, null);
  const submit = await prisma.jobWorkItem.findFirstOrThrow({ where: { ...who, applicationId, revision, kind: "submit" } });
  assert.equal(submit.state, "queued");
  const retrieved = await ownerRequest(path + "/resume.pdf?revision=" + revision);
  assert.equal(retrieved.status, 200);
  assert.deepEqual(Buffer.from(await retrieved.arrayBuffer()), bytes);
  const file = "/tmp/qs-approved-resume.pdf";
  await writeFile(file, bytes, { mode: 0o600 });
  const text = Bun.spawn(["pdftotext", file, "-"], { stdout: "pipe" });
  const extracted = await new Response(text.stdout).text();
  assert.equal(await text.exited, 0);
  assert(extracted.includes(current.applicationAddress), "The PDF must print its scratch-issued Application Address");
  assert(!extracted.includes(globalContact), "The PDF must omit the synthetic global email");
  assert(!extracted.includes(placeholder), "The renderer must replace the template contact placeholder");
  assert(extracted.includes("Prepared Excel reports"));
  assert(extracted.includes("Maintained client records"));
  const raster = Bun.spawn(["pdftoppm", "-f", "1", "-singlefile", "-r", "120", "-png", file, "/tmp/qs-approved-resume"]);
  assert.equal(await raster.exited, 0);
  return { applicationId, approvedRevision: revision, sha256: digest, bytes: bytes.length, renderMs,
    elapsedMs: Math.round(performance.now() - started), renderRequests, ownerRequests: productCalls, textVerified: true,
    applicationAddressVerified: true, globalContactExcluded: true };
}

async function snapshot() {
  const [applications, bindings, work, imports] = await Promise.all([
    prisma.jobApplication.findMany({ where: who, orderBy: { id: "asc" },
      select: { id: true, sourceUrl: true, description: true, status: true, revision: true, approvedRevision: true } }),
    prisma.jobProviderPosting.findMany({ where: who, orderBy: { sourceIdentity: "asc" },
      select: { applicationId: true, sourceIdentity: true } }),
    prisma.jobWorkItem.findMany({ where: who, orderBy: [{ applicationId: "asc" }, { kind: "asc" }],
      select: { applicationId: true, kind: true, state: true, revision: true } }),
    prisma.apiIdempotencyKey.findMany({ where: { clientId: credential.id, responseStatus: 200 },
      select: { responseBody: true }, orderBy: { createdAt: "asc" } }),
  ]);
  return { applications, bindings, work, imports: imports.map(row => row.responseBody) };
}

async function finish() {
  const initial = await snapshot();
  assert.equal(initial.applications.length, 3);
  assert.equal(initial.bindings.length, 3);
  const application = initial.applications[0]!;
  const detail = applicationsPath + "/" + application.id;
  const denied: Record<string, number> = {};
  async function deny(name: string, method: string, path: string, expected: number, body?: unknown, bearer = false) {
    const response = await fetch(loopback + path, {
      method, headers: { "X-API-Key": secret, "Content-Type": "application/json", "Idempotency-Key": randomUUID(),
        ...(bearer && { Authorization: "Bearer " + secret }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, expected, name);
    denied[name] = response.status;
  }
  const posting = { sourceUrl: "https://example.test/denied", company: "Synthetic", role: "Editor",
    track: "admin", postingText: "Fixture posting for permission probes." };
  await deny("add outside import", "POST", applicationsPath, 403, posting);
  await deny("read draft", "GET", detail, 403);
  await deny("edit summary", "PATCH", detail, 403, { expectedRevision: 0, summaryMarkdown });
  await deny("approve draft", "POST", detail + "/decision", 403, { action: "approve", expectedRevision: 0 });
  await deny("set outcome through import", "POST", applicationsPath + "/import", 403, { applications: [{ ...posting, recordedStatus: "applied" }] });
  await deny("supply full résumé", "POST", applicationsPath + "/import", 403, { applications: [{ ...posting, resumeMarkdown: template }] });
  await deny("claim worker job", "POST", "/api/internal/jobs/work/claim", 401, { workerId: "fixture", kinds: ["enrich"] }, true);
  assert.deepEqual(await snapshot(), initial, "A denied operation must leave the database unchanged");

  const client = createJobsWorkClient({ baseUrl: loopback, secret: codex });
  const runStarted = performance.now();
  const enriched = new Set<string>();
  assert(initial.applications.every(row => row.status === "draft"));
  for (let index = 0; index < initial.applications.length; index++) {
    const work = await client.claim({ workerId: "n8n-feed-fixture", kinds: ["enrich"] });
    assert(work?.kind === "enrich");
    assert(!enriched.has(work.applicationId));
    assert(initial.applications.some(item => item.id === work.applicationId));
    enriched.add(work.applicationId);
    await client.report({ action: "complete", kind: "enrich", id: work.id, body: { leaseToken: work.leaseToken, resultId: randomUUID(), result: {
      doing: "Maintains remote Excel reports.", remote: "confirmed", eligible: true, ineligibleReason: null,
      companySize: { people: null, label: "Unknown" }, automatable: "medium",
      humanContact: { level: "low", note: "Async updates" }, meetings: { level: "rare", note: "Planning" },
      pay: null, verdict: "strong", dueDate: null,
    } } });
  }
  assert.equal(await client.claim({ workerId: "n8n-feed-fixture", kinds: ["enrich"] }), null);
  const afterEnrichment = await snapshot();
  assert.deepEqual(afterEnrichment.work.filter(item => item.kind === "tailor").map(item => [item.applicationId, item.state, item.revision]),
    initial.applications.map(item => [item.id, "queued", 0]));

  const tailor = await client.claim({ workerId: "n8n-feed-fixture", kinds: ["tailor"] });
  assert(tailor?.kind === "tailor");
  assert.equal(tailor.input.resumeMarkdown, template.trimEnd() + "\n");
  await client.report({ action: "complete", kind: "tailor", id: tailor.id,
    body: { leaseToken: tailor.leaseToken, resultId: randomUUID(), result: { summaryMarkdown } } });
  const review = await fetch(loopback + "/api/v1/jobs/review-session?ids=" + tailor.applicationId, { headers: { Origin: origin, "x-quantself-owner-proof": proof } });
  assert.equal(review.status, 200, "Owner review");
  const body = await review.json() as { items: { id: string; status: string; summaryMarkdown: string; revision: number }[] };
  const item = body.items[0]!;
  assert.equal(item.id, tailor.applicationId);
  assert.equal(item.status, "review");
  assert.equal(item.revision, 1);
  assert.equal(item.summaryMarkdown, summaryMarkdown);
  const final = await snapshot();
  assert.deepEqual(final.bindings, initial.bindings);
  assert.equal(final.work.filter(item => item.kind === "tailor").length, 3);
  assert.equal(final.work.filter(item => item.kind === "render" && item.applicationId === tailor.applicationId && item.state === "queued").length, 1);
  assert(final.applications.every(item => item.approvedRevision === null));
  assert(final.work.every(item => item.kind !== "submit"));
  const workerMs = Math.round(performance.now() - runStarted);
  const workRequests = workerCalls.slice();
  const pdf = runner ? await verifyOwnerPdf(item.id, item.revision, runner) : undefined;
  return { denied, enriched: enriched.size, tailoringRequests: 3, workerCalls: workRequests, workerMs,
    ownerReviewRequests: 1, reviewed: item, queuedRender: 1, ...(pdf && { pdf }) };
}

let finished = false;
Bun.serve({ hostname: "0.0.0.0", port: 3001, idleTimeout: 60, async fetch(request) {
  try {
    const path = new URL(request.url).pathname;
    switch (path) {
      case "/__fixture/ready": return Response.json({ ready: true });
      case "/__fixture/key": return Response.json({ key: secret });
      case "/__fixture/snapshot": return Response.json(await snapshot());
      case "/__fixture/finish":
        assert(request.method === "POST" && !finished);
        finished = true;
        return Response.json(await finish());
      default: {
        const started = performance.now();
        const response = await app.fetch(request);
        if (path.startsWith("/api/internal/jobs/") && response.ok) {
          workerCalls.push({ route: path.split("/").at(-1)!, status: response.status, elapsedMs: Math.round(performance.now() - started) });
        }
        return response;
      }
    }
  } catch (error) {
    console.error(error);
    return new Response("Jobs feed fixture assertion failed", { status: 500 });
  }
} });
console.log("Jobs API fixture listening on the internal network.");
