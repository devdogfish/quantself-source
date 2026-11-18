CREATE TABLE "api_idempotency_key" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_idempotency_key_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_idempotency_key_clientId_operation_idempotencyKey_key"
ON "api_idempotency_key"("clientId", "operation", "idempotencyKey");

CREATE INDEX "api_idempotency_key_clientId_operation_idx"
ON "api_idempotency_key"("clientId", "operation");
