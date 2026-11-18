CREATE TABLE "job_missing_detail" (
    "ownerId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "resumeTrack" "JobResumeTrack" NOT NULL,
    "key" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL,
    "firstMissingAt" TIMESTAMP(3) NOT NULL,
    "noticeClaimedAt" TIMESTAMP(3),
    "phoneClaimedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "job_missing_detail_pkey" PRIMARY KEY ("ownerId", "applicationId", "resumeTrack", "key"),
    CONSTRAINT "job_missing_detail_application_fkey" FOREIGN KEY ("ownerId", "applicationId") REFERENCES "job_application"("ownerId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "job_missing_detail_ownerId_resolvedAt_firstMissingAt_idx" ON "job_missing_detail"("ownerId", "resolvedAt", "firstMissingAt");
CREATE INDEX "job_missing_detail_ownerId_phoneClaimedAt_idx" ON "job_missing_detail"("ownerId", "phoneClaimedAt");
