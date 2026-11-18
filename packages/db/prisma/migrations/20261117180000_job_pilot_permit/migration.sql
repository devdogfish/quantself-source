CREATE TABLE "job_pilot_permit" (
  "ownerId" TEXT NOT NULL,
  "id" UUID NOT NULL,
  "sourceIdentity" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "applicationId" TEXT,
  "revision" INTEGER,
  CONSTRAINT "job_pilot_permit_pkey" PRIMARY KEY ("ownerId", "id"),
  CONSTRAINT "job_pilot_permit_source_identity" CHECK ("sourceIdentity" ~ '^greenhouse:global:[a-z0-9_-]{1,120}:[1-9][0-9]{0,15}$'),
  CONSTRAINT "job_pilot_permit_expiration" CHECK ("expiresAt" > "issuedAt"),
  CONSTRAINT "job_pilot_permit_draft_binding" CHECK (
    ("applicationId" IS NULL AND "revision" IS NULL)
    OR ("applicationId" IS NOT NULL AND "revision" IS NOT NULL AND "revision" >= 0)
  )
);

CREATE UNIQUE INDEX "job_pilot_permit_ownerId_applicationId_key"
  ON "job_pilot_permit" ("ownerId", "applicationId");
