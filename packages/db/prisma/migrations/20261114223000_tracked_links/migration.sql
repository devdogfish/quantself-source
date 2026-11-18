BEGIN;

CREATE TABLE "tracked_link" (
    "code" VARCHAR(64) PRIMARY KEY,
    "kind" VARCHAR(11) NOT NULL,
    "application_id" UUID UNIQUE,
    "track" VARCHAR(20),
    "company" VARCHAR(200),
    "title" VARCHAR(200) NOT NULL,
    "revision" INTEGER,
    "channel" VARCHAR(8),
    "destination_path" VARCHAR(240),
    "posted_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tracked_link_kind_fields_check" CHECK (
      (kind = 'application' AND code ~ '^([A-Za-z0-9]{16}|[a-f0-9]{24})$'
       AND application_id IS NOT NULL AND track IS NOT NULL
       AND track IN ('software', 'web-cms', 'admin-excel')
       AND company IS NOT NULL AND revision IS NOT NULL AND revision > 0
       AND channel IS NULL AND destination_path IS NULL AND posted_at IS NULL)
      OR
      (kind = 'post' AND code ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND code !~ '^[a-f0-9]{24}$'
       AND application_id IS NULL AND track IS NULL AND company IS NULL AND revision IS NULL
       AND channel IS NOT NULL AND channel IN ('linkedin', 'youtube', 'github', 'other')
       AND destination_path IS NOT NULL AND posted_at IS NOT NULL AND sent_at IS NULL)
    )
);

INSERT INTO "tracked_link" (code, kind, application_id, track, company, title, revision, created_at, sent_at)
SELECT old.code, 'application', old."applicationId", old.cohort, old.company, old.role, old.revision, old."createdAt",
       min(job."appliedAt")
FROM "WebsiteApplication" old
LEFT JOIN "job_application" job ON job.id = old."applicationId"::text
GROUP BY old."applicationId";

DROP TABLE "WebsiteApplication";

COMMIT;
