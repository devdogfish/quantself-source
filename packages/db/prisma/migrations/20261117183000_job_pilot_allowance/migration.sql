CREATE TABLE "job_pilot_allowance" (
  "ownerId" TEXT NOT NULL,
  "id" UUID NOT NULL,
  "limitNanoUsd" BIGINT NOT NULL,
  "heldNanoUsd" BIGINT NOT NULL DEFAULT 0,
  "spentNanoUsd" BIGINT NOT NULL DEFAULT 0,
  "screenCalls" INTEGER NOT NULL DEFAULT 0,
  "enrichCalls" INTEGER NOT NULL DEFAULT 0,
  "tailorCalls" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "job_pilot_allowance_pkey" PRIMARY KEY ("ownerId", "id"),
  CONSTRAINT "job_pilot_allowance_limit" CHECK (
    "limitNanoUsd" BETWEEN 1 AND 100000000 AND "heldNanoUsd" >= 0 AND "spentNanoUsd" >= 0
    AND "heldNanoUsd" <= "limitNanoUsd" - "spentNanoUsd"
  ),
  CONSTRAINT "job_pilot_allowance_calls" CHECK (
    "screenCalls" BETWEEN 0 AND 2 AND "enrichCalls" BETWEEN 0 AND 1 AND "tailorCalls" BETWEEN 0 AND 1
  )
);

ALTER TABLE "job_pilot_permit" ADD COLUMN "allowanceId" UUID,
  ADD CONSTRAINT "job_pilot_permit_allowance_fkey" FOREIGN KEY ("ownerId", "allowanceId")
    REFERENCES "job_pilot_allowance" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "job_pilot_screen_attempt" ADD COLUMN "allowanceId" UUID,
  ADD CONSTRAINT "job_pilot_screen_attempt_allowance_fkey" FOREIGN KEY ("ownerId", "allowanceId")
    REFERENCES "job_pilot_allowance" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "job_pilot_screen_attempt_token_cap" CHECK (
    "allowanceId" IS NULL OR ("maxInputTokens" <= 20000 AND "maxOutputTokens" <= 384)
  );

CREATE TABLE "job_pilot_model_attempt" (
  "ownerId" TEXT NOT NULL,
  "permitId" UUID NOT NULL,
  "allowanceId" UUID NOT NULL,
  "phase" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "policyDigest" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL,
  "maxOutputTokens" INTEGER NOT NULL,
  "inputNanoUsdPerToken" BIGINT NOT NULL,
  "outputNanoUsdPerToken" BIGINT NOT NULL,
  "reservedNanoUsd" BIGINT NOT NULL,
  "resultId" UUID,
  "workId" TEXT,
  "leaseTokenHash" TEXT,
  "providerRequestId" TEXT,
  "usage" JSONB,
  "result" JSONB,
  "chargedNanoUsd" BIGINT,
  "reportedAt" TIMESTAMP(3),
  CONSTRAINT "job_pilot_model_attempt_pkey" PRIMARY KEY ("ownerId", "permitId", "phase"),
  CONSTRAINT "job_pilot_model_attempt_permit_fkey" FOREIGN KEY ("ownerId", "permitId")
    REFERENCES "job_pilot_permit" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "job_pilot_model_attempt_allowance_fkey" FOREIGN KEY ("ownerId", "allowanceId")
    REFERENCES "job_pilot_allowance" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "job_pilot_model_attempt_cap" CHECK (
    "phase" IN ('enrich', 'tailor') AND "inputTokens" BETWEEN 1 AND 30000 AND "maxOutputTokens" BETWEEN 1 AND 1200
    AND "reservedNanoUsd" BETWEEN 1 AND 100000000 AND "inputNanoUsdPerToken" > 0 AND "outputNanoUsdPerToken" > 0
    AND "inputTokens" * "inputNanoUsdPerToken" + "maxOutputTokens" * "outputNanoUsdPerToken" <= "reservedNanoUsd"
  ),
  CONSTRAINT "job_pilot_model_attempt_claim" CHECK (
    ("resultId" IS NULL AND "workId" IS NULL AND "leaseTokenHash" IS NULL)
    OR ("resultId" IS NOT NULL AND "workId" IS NOT NULL AND "leaseTokenHash" IS NOT NULL)
  ),
  CONSTRAINT "job_pilot_model_attempt_reply" CHECK (
    ("chargedNanoUsd" IS NULL AND "providerRequestId" IS NULL AND "usage" IS NULL AND "result" IS NULL AND "reportedAt" IS NULL)
    OR ("chargedNanoUsd" IS NOT NULL AND "chargedNanoUsd" BETWEEN 1 AND "reservedNanoUsd" AND "resultId" IS NOT NULL
      AND "providerRequestId" IS NOT NULL AND "usage" IS NOT NULL AND "result" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "job_pilot_model_attempt_resultId_key" ON "job_pilot_model_attempt" ("resultId");
CREATE UNIQUE INDEX "job_pilot_model_attempt_providerRequestId_key" ON "job_pilot_model_attempt" ("providerRequestId");
