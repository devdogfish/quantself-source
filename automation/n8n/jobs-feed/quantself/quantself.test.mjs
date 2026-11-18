import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareQuantselfBatches, summarizeQuantselfImports } from "./quantself.mjs";

function posting(id, overrides = {}) {
  return {
    company: "Fixture Inc",
    role: "Reporting Analyst",
    sourceIdentity: `fixture:example.com:${id}`,
    sourceUrl: `https://example.com/careers/${id}`,
    category: "excel",
    resumeTrack: "admin",
    fitNote: "Excel reporting and spreadsheet work.",
    description: "Builds spreadsheets used for monthly reporting.",
    ...overrides,
  };
}

test("sends a strict draft payload and keeps the fit note visible in Jobs", () => {
  const [batch] = prepareQuantselfBatches([
    posting(1, { sourceStatus: "applied", summary: "discard", location: " Halifax ", salary: " $50k " }),
    posting(1, { sourceUrl: "https://example.com/careers/1?utm_source=other" }),
  ], "workflow_7-123");
  assert.deepEqual(batch, {
    idempotencyKey: "n8n-jobs-import-workflow_7-123-1",
    body: {
      applications: [{
        company: "Fixture Inc",
        role: "Reporting Analyst",
        sourceUrl: "https://example.com/careers/1",
        track: "admin",
        source: "n8n Jobs feed",
        postingText: "Fit note (excel): Excel reporting and spreadsheet work.\n\nBuilds spreadsheets used for monthly reporting.",
        location: "Halifax",
        salary: "$50k",
      }],
    },
  });
  assert.deepEqual(prepareQuantselfBatches([], "workflow_7-123"), []);
  assert.equal(prepareQuantselfBatches([posting(1, { sourceLabel: " We Work Remotely " })], "r")[0]
    .body.applications[0].source, "n8n Jobs feed · We Work Remotely");
  assert.throws(() => prepareQuantselfBatches([posting(1, { resumeTrack: "web" })], "r"));
  assert.throws(() => prepareQuantselfBatches([posting(1, { sourceUrl: "https://user:pass@example.com/jobs" })], "r"));
});

test("bounds request count, payload bytes and description length", () => {
  const candidates = Array.from({ length: 101 }, (_, index) => posting(index));
  const small = prepareQuantselfBatches(candidates, "small");
  assert.deepEqual(small.map(batch => batch.body.applications.length), [100, 1]);

  const large = prepareQuantselfBatches(candidates.map(candidate => ({
    ...candidate, description: "路".repeat(12_001),
  })), "large");
  assert.equal(large.length, 4);
  for (const batch of large) {
    assert.ok(Buffer.byteLength(JSON.stringify(batch.body)) < 1_500_000);
    assert.ok(batch.body.applications.every(application =>
      application.postingText.length === 12_000 && application.postingText.startsWith("Fit note (excel):")));
  }
});

// Fixture for the import route's two independent guarantees: the same key
// replays the earlier counts, and a fresh key still skips stored posting URLs.
function fixtureImport() {
  const requests = new Map();
  const urls = new Set();
  return batch => {
    const previous = requests.get(batch.idempotencyKey);
    const payload = JSON.stringify(batch.body);
    if (previous) {
      return previous.payload === payload ? previous.response : { statusCode: 409 };
    }
    const { applications } = batch.body;
    const before = urls.size;
    for (const { sourceUrl } of applications) {
      const url = new URL(sourceUrl);
      urls.add(url.origin + url.pathname);
    }
    const imported = urls.size - before;
    const response = { statusCode: 200, body: { imported, duplicates: applications.length - imported } };
    requests.set(batch.idempotencyKey, { payload, response });
    return response;
  };
}

test("reuses the original request after a lost reply and skips existing jobs on a fresh run", () => {
  const importFixture = fixtureImport();
  const original = prepareQuantselfBatches([posting(1)], "workflow-a");
  importFixture(original[0]);
  const replay = summarizeQuantselfImports(original, [importFixture(structuredClone(original[0]))]);
  assert.equal(replay.imported, 1);
  assert.equal(replay.duplicates, 0);
  assert.deepEqual(replay.tailoring, {
    status: "enrichment_queued",
    drafts: 1,
    path: "/jobs/applications",
    reviewBatches: [{
      imported: 1, duplicates: 0,
      candidates: [{ company: "Fixture Inc", role: "Reporting Analyst", sourceUrl: "https://example.com/careers/1" }],
    }],
    action: "Review the imported applications in Jobs after tailoring finishes.",
  });
  assert.equal(importFixture({
    ...original[0],
    body: { applications: [posting(2)] },
  }).statusCode, 409);

  const fresh = prepareQuantselfBatches([
    posting(1, { sourceUrl: "https://example.com/careers/1?utm_source=feed" }),
  ], "workflow-b");
  assert.deepEqual(summarizeQuantselfImports(fresh, [importFixture(fresh[0])]), {
    imported: 0, duplicates: 1, failedBatches: [], tailoring: { status: "no_new_drafts", drafts: 0 },
  });
});

test("preserves confirmed counts and marks unconfirmed requests", () => {
  const batches = prepareQuantselfBatches(Array.from({ length: 101 }, (_, index) => posting(index)), "partial");
  const summary = summarizeQuantselfImports(batches, [{ statusCode: 200, body: { imported: 60, duplicates: 40 } }, null]);
  assert.equal(summary.imported, 60);
  assert.equal(summary.duplicates, 40);
  assert.deepEqual(summary.failedBatches, [{ idempotencyKey: batches[1].idempotencyKey, statusCode: null, applications: 1 }]);
  assert.equal(summary.tailoring.drafts, 60);
  assert.deepEqual(summarizeQuantselfImports(batches, [{ statusCode: 503 }, { statusCode: 200, body: { imported: 8, duplicates: 1 } }]).tailoring, {
    status: "import_unconfirmed", drafts: 0,
  });
});

test("carries Greenhouse identity to the current import when its public URL changes", () => {
  const sourceIdentity = "greenhouse:global:fixture:1234";
  const sourceUrls = ["https://example.test/posting-one", "https://example.test/posting-two"];
  const batches = sourceUrls.map((sourceUrl, index) => prepareQuantselfBatches([
    posting("1234", { sourceIdentity, sourceUrl }),
  ], "run-" + index)[0]);
  assert.deepEqual(batches.map(batch => batch.body.applications[0].sourceUrl), sourceUrls);
  assert.deepEqual(batches.map(batch => batch.body.applications[0].sourceIdentity), [sourceIdentity, sourceIdentity]);
});
