BEGIN;

-- Stop the old workers before applying the Jobs cutover.
LOCK TABLE "job_application", "job_work" IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO "job_revision" ("ownerId", "applicationId", revision, "summaryMarkdown", "resumeMarkdown", "createdAt")
SELECT "ownerId", id, revision, summary, "resumeMarkdown", "updatedAt"
FROM "job_application"
WHERE "workflowVersion" = 1
ON CONFLICT ("ownerId", "applicationId", revision) DO NOTHING;

UPDATE "job_application"
SET receipt = jsonb_strip_nulls(jsonb_build_object(
  'code', "receiptCode"::text, 'source', 'legacy', 'sesMessageId', "sesMessageId",
  'appliedAt', to_char("appliedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
))
WHERE "workflowVersion" = 1 AND "receiptCode" IS NOT NULL AND receipt IS NULL;

INSERT INTO "job_event" ("ownerId", "applicationId", id, kind, revision, "eventKey", payload, "occurredAt")
SELECT "ownerId", id, gen_random_uuid()::text, 'receipt_recorded', COALESCE("approvedRevision", revision),
       'legacy-receipt', receipt, COALESCE("appliedAt", "updatedAt")
FROM "job_application"
WHERE "workflowVersion" = 1 AND "receiptCode" IS NOT NULL AND receipt->>'source' = 'legacy'
ON CONFLICT ("ownerId", "applicationId", "eventKey") DO NOTHING;

INSERT INTO "job_event" ("ownerId", "applicationId", id, kind, revision, "eventKey", payload, "occurredAt")
SELECT "ownerId", "applicationId", gen_random_uuid()::text, 'legacy_work', revision, 'legacy-work:' || id,
       jsonb_strip_nulls(jsonb_build_object('kind', kind, 'state', state, 'previewDigest', "previewDigest",
         'originalApprovalRevision', "originalApprovalRevision", 'resultHash', "resultHash")),
       "createdAt"
FROM "job_work"
ON CONFLICT ("ownerId", "applicationId", "eventKey") DO NOTHING;

INSERT INTO "job_event" ("ownerId", "applicationId", id, kind, revision, "eventKey", payload, "occurredAt")
SELECT "ownerId", id, gen_random_uuid()::text, 'legacy_cutover', revision, 'legacy-cutover',
       jsonb_strip_nulls(jsonb_build_object('status', status, 'approvedRevision', "approvedRevision",
          'approvedPreviewDigest', "approvedPreviewDigest", 'privatePause', "privatePause", 'revisionPending', "revisionPending")),
       "updatedAt"
FROM "job_application"
WHERE "workflowVersion" = 1 AND (
  status IN ('approved', 'queued', 'submitting') OR "issueCode" = 'submission_uncertain'
  OR "privatePause" IS NOT NULL OR "revisionPending"
)
ON CONFLICT ("ownerId", "applicationId", "eventKey") DO NOTHING;

-- A previous browser handoff may have reached the employer.
UPDATE "job_application"
SET status = 'needs_attention', "issueCode" = 'submission_uncertain', "submitLeaseUntil" = NULL, "privatePause" = NULL
WHERE "workflowVersion" = 1 AND (status = 'submitting' OR "issueCode" = 'submission_uncertain');

-- Old approval evidence is retained above. Fresh approval pins the first stored PDF.
UPDATE "job_application"
SET status = CASE WHEN btrim(summary) <> '' THEN 'review'::"JobApplicationStatus" ELSE 'draft'::"JobApplicationStatus" END,
    "approvedRevision" = NULL, "approvedPreviewDigest" = NULL, "issueCode" = NULL, "privatePause" = NULL, "submitLeaseUntil" = NULL
WHERE "workflowVersion" = 1 AND "issueCode" IS DISTINCT FROM 'submission_uncertain' AND (
  status IN ('approved', 'queued') OR "privatePause" IS NOT NULL OR "revisionPending"
);

DROP TABLE "job_work";
DROP TYPE "JobWorkKind";
DROP TYPE "JobWorkState";
ALTER TABLE "job_application" DROP COLUMN "workflowVersion", DROP COLUMN "revisionPending";

COMMIT;
