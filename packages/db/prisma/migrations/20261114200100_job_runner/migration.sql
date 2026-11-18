CREATE TABLE "job_runner" (
  "ownerId" TEXT NOT NULL,
  "host" TEXT NOT NULL,
  "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
  "paused" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "job_runner_pkey" PRIMARY KEY ("ownerId")
);
