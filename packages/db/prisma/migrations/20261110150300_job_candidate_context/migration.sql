CREATE TABLE "job_candidate_context" (
    "ownerId" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "version" INTEGER NOT NULL CHECK ("version" > 0),

    CONSTRAINT "job_candidate_context_pkey" PRIMARY KEY ("ownerId")
);
