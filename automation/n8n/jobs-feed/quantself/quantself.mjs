const maxRows = 100;
// UTF-8 uses at most three bytes per UTF-16 code unit. Leave room under the
// 1,500,000 byte API limit for JSON serialization and transport.
const maxJsonLength = 400_000;
const resumeTracks = { admin: "admin", excel: "admin", web: "web", engineering: "engineering" };

function requiredText(value, field, limit) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit) {
    throw new Error(`Invalid Quantself import field: ${field}.`);
  }
  return value.trim();
}

function importRow(candidate) {
  const sourceUrl = requiredText(candidate.sourceUrl, "sourceUrl", 2_048);
  // Source adapters validate public hosts and canonicalize the posting URL.
  if (!/^https?:\/\/[a-z\d-]+(?:\.[a-z\d-]+)+(?::\d+)?(?:[/?#]|$)/i.test(sourceUrl)) {
    throw new Error("Invalid Quantself posting URL.");
  }

  const { category, resumeTrack } = candidate;
  if (!Object.hasOwn(resumeTracks, category) || resumeTrack !== resumeTracks[category]) {
    throw new Error("Invalid Quantself résumé track.");
  }

  const fit = requiredText(candidate.fitNote, "fitNote", 240);
  const note = `Fit note (${category}): ${fit}`;
  const posting = typeof candidate.description === "string" ? candidate.description.trim() : "";
  const description = posting
    ? `${note}\n\n${posting.slice(0, 12_000 - note.length - 2).trimEnd()}`
    : note;

  const feedLabel = "n8n Jobs feed";
  const sourceLabel = typeof candidate.sourceLabel === "string" && candidate.sourceLabel.trim()
    ? `${feedLabel} · ${candidate.sourceLabel.trim()}`.slice(0, 120) : feedLabel;

  return {
    company: requiredText(candidate.company, "company", 200),
    role: requiredText(candidate.role, "role", 200),
    sourceUrl,
    track: resumeTrack,
    source: sourceLabel,
    postingText: description,
    ...(typeof candidate.location === "string" && candidate.location.trim()
      ? { location: candidate.location.trim().slice(0, 200) } : {}),
    ...(typeof candidate.salary === "string" && candidate.salary.trim()
      ? { salary: candidate.salary.trim().slice(0, 200) } : {}),
  };
}

export function prepareQuantselfBatches(candidates, runId) {
  const executionId = requiredText(runId, "runId", 150);
  if (!/^[a-z0-9_-]+$/i.test(executionId)) throw new Error("Invalid Quantself import run identifier.");
  const seen = new Set();
  const batches = [];
  let applications = [];
  let length = '{"applications":[]}'.length;

  function finishBatch() {
    const body = { applications };
    batches.push({ idempotencyKey: `n8n-jobs-import-${executionId}-${batches.length + 1}`, body });
    applications = [];
    length = '{"applications":[]}'.length;
  }

  for (const candidate of candidates) {
    const identity = requiredText(candidate.sourceIdentity, "sourceIdentity", 2_048);
    if (seen.has(identity)) continue;
    const row = importRow(candidate);
    if (identity.startsWith("greenhouse:global:")) row.sourceIdentity = identity;
    const rowLength = JSON.stringify(row).length + 1;
    if (applications.length >= maxRows || length + rowLength > maxJsonLength) finishBatch();
    applications.push(row);
    length += rowLength;
    seen.add(identity);
  }
  if (applications.length) finishBatch();
  return batches;
}

export function summarizeQuantselfImports(batches, responses) {
  if (batches.length !== responses.length) throw new Error("Expected one Quantself response per batch.");
  let imported = 0;
  let duplicates = 0;
  const failedBatches = [];
  const reviewBatches = [];

  for (const [index, batch] of batches.entries()) {
    const { statusCode = null, body } = responses[index] ?? {};
    const count = batch.body.applications.length;
    if (statusCode !== 200 || !Number.isInteger(body?.imported) || !Number.isInteger(body?.duplicates) ||
        body.imported < 0 || body.duplicates < 0 || body.imported + body.duplicates !== count) {
      failedBatches.push({ idempotencyKey: batch.idempotencyKey, statusCode, applications: count });
      continue;
    }
    imported += body.imported;
    duplicates += body.duplicates;
    if (body.imported > 0) reviewBatches.push({
      imported: body.imported,
      duplicates: body.duplicates,
      candidates: batch.body.applications.map(({ company, role, sourceUrl }) => ({ company, role, sourceUrl })),
    });
  }

  return {
    imported,
    duplicates,
    failedBatches,
    tailoring: imported > 0 ? {
      status: "enrichment_queued",
      drafts: imported,
      path: "/jobs/applications",
      reviewBatches,
      action: "Review the imported applications in Jobs after tailoring finishes.",
    } : { status: failedBatches.length ? "import_unconfirmed" : "no_new_drafts", drafts: 0 },
  };
}
