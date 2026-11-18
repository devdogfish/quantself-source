CREATE TABLE "job_provider_posting" (
    "ownerId" TEXT NOT NULL,
    "sourceIdentity" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    CONSTRAINT "job_provider_posting_pkey" PRIMARY KEY ("ownerId", "sourceIdentity"),
    CONSTRAINT "job_provider_posting_ownerId_applicationId_fkey"
        FOREIGN KEY ("ownerId", "applicationId") REFERENCES "job_application"("ownerId", "id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "job_provider_posting_ownerId_applicationId_idx"
    ON "job_provider_posting"("ownerId", "applicationId");
