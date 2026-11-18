CREATE TABLE "WebsiteApplication" (
  "applicationId" UUID PRIMARY KEY,
  "code" VARCHAR(24) NOT NULL UNIQUE,
  "company" VARCHAR(200) NOT NULL,
  "role" VARCHAR(200) NOT NULL,
  "cohort" VARCHAR(20) NOT NULL CHECK ("cohort" IN ('software', 'web-cms', 'admin-excel')),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "WebsiteApplication_createdAt_idx" ON "WebsiteApplication" ("createdAt" DESC);
