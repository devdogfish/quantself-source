CREATE TABLE "todo_cache_state" (
 "scope" TEXT PRIMARY KEY, "revision" INTEGER NOT NULL DEFAULT 0,
 "generation" INTEGER NOT NULL DEFAULT 0, "metadata" JSONB NOT NULL,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "todo_cache_projection" (
 "scope" TEXT NOT NULL, "number" INTEGER NOT NULL, "data" JSONB NOT NULL,
 PRIMARY KEY ("scope", "number")
);
CREATE TABLE "todo_cache_event" (
 "scope" TEXT NOT NULL, "generation" INTEGER NOT NULL, "data" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("scope", "generation")
);
CREATE INDEX "todo_cache_event_createdAt_idx" ON "todo_cache_event"("createdAt");
CREATE TABLE "todo_webhook_delivery" (
 "scope" TEXT NOT NULL, "delivery" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("scope", "delivery")
);
CREATE INDEX "todo_webhook_delivery_createdAt_idx" ON "todo_webhook_delivery"("createdAt");
