CREATE TABLE "job_pilot_screen_attempt" (
  "ownerId" TEXT NOT NULL,
  "permitId" UUID NOT NULL,
  "id" UUID NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "posting" JSONB NOT NULL,
  "maxInputTokens" INTEGER NOT NULL,
  "maxOutputTokens" INTEGER NOT NULL,
  "inputNanoUsdPerToken" BIGINT NOT NULL,
  "outputNanoUsdPerToken" BIGINT NOT NULL,
  "reservedNanoUsd" BIGINT NOT NULL,
  "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "chargedNanoUsd" BIGINT,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "providerRequestId" TEXT,
  "receiptDigest" TEXT,
  "settledAt" TIMESTAMP(3),
  "intakePosting" JSONB,
  CONSTRAINT "job_pilot_screen_attempt_pkey" PRIMARY KEY ("ownerId", "permitId"),
  CONSTRAINT "job_pilot_screen_attempt_permit_fkey" FOREIGN KEY ("ownerId", "permitId")
    REFERENCES "job_pilot_permit" ("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "job_pilot_screen_attempt_reservation" CHECK (
    "maxInputTokens" > 0 AND "maxOutputTokens" > 0 AND "inputNanoUsdPerToken" > 0 AND "outputNanoUsdPerToken" > 0
    AND "reservedNanoUsd" = "maxInputTokens" * "inputNanoUsdPerToken" + "maxOutputTokens" * "outputNanoUsdPerToken"
  ),
  CONSTRAINT "job_pilot_screen_attempt_settlement" CHECK (
    ("settledAt" IS NULL AND "chargedNanoUsd" IS NULL AND "providerRequestId" IS NULL AND "receiptDigest" IS NULL
      AND "inputTokens" IS NULL AND "outputTokens" IS NULL AND "intakePosting" IS NULL)
    OR ("settledAt" IS NOT NULL AND "chargedNanoUsd" IS NOT NULL AND "chargedNanoUsd" BETWEEN 1 AND "reservedNanoUsd"
      AND "inputTokens" IS NOT NULL AND "inputTokens" BETWEEN 1 AND "maxInputTokens"
      AND "outputTokens" IS NOT NULL AND "outputTokens" BETWEEN 1 AND "maxOutputTokens"
      AND "chargedNanoUsd" = "inputTokens" * "inputNanoUsdPerToken" + "outputTokens" * "outputNanoUsdPerToken"
      AND "providerRequestId" IS NOT NULL AND "receiptDigest" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "job_pilot_screen_attempt_id_key" ON "job_pilot_screen_attempt" ("id");
CREATE UNIQUE INDEX "job_pilot_screen_attempt_providerRequestId_key" ON "job_pilot_screen_attempt" ("providerRequestId");
