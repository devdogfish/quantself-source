CREATE TABLE "api_idempotency_request" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "responseBody" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "api_idempotency_request_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_idempotency_request_clientId_operationId_key_key"
ON "api_idempotency_request"("clientId", "operationId", "key");

CREATE INDEX "api_idempotency_request_createdAt_idx"
ON "api_idempotency_request"("createdAt");
