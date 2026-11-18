-- Apply to an empty disposable database after the old WebsiteApplication migration.
CREATE TABLE "job_application" (id TEXT NOT NULL, "appliedAt" TIMESTAMP(3));
INSERT INTO "job_application" VALUES ('e7bdf9d4-4762-48fb-b1fc-bc689be260fc', '2026-11-01 10:00:00');

INSERT INTO "WebsiteApplication" ("applicationId", code, company, role, cohort, revision, "createdAt")
VALUES
  ('e7bdf9d4-4762-48fb-b1fc-bc689be260fc', '0123456789abcdef01234567',
   'Example Studio', 'Developer', 'software', 3, '2026-10-31 10:00:00'),
  ('5a5a4d60-a054-42ce-8d51-4490737b4062', 'fedcba9876543210fedcba98',
   'Example Studio', 'Administrator', 'admin-excel', 1, '2026-10-31 10:00:00');
