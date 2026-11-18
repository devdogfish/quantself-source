CREATE TABLE "original_file" (
  "key" TEXT PRIMARY KEY, "provider" TEXT NOT NULL DEFAULT 'opencloud',
  "spaceId" TEXT NOT NULL, "fileId" TEXT, "pathHint" TEXT NOT NULL,
  "mime" TEXT NOT NULL, "bytes" INTEGER NOT NULL, "sha256" TEXT NOT NULL,
  "etag" TEXT, "state" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "original_file_state" CHECK ("state" IN ('pending','ready','deleting','deleted')),
  CONSTRAINT "original_file_ready" CHECK ("state" <> 'ready' OR ("fileId" IS NOT NULL AND "etag" IS NOT NULL)),
  CONSTRAINT "original_file_bytes" CHECK ("bytes" >= 0)
);
CREATE INDEX "original_file_state_updatedAt_idx" ON "original_file"("state", "updatedAt");
CREATE INDEX "original_file_sha256_idx" ON "original_file"("sha256");
CREATE TABLE "original_upload_attempt" (
  "id" TEXT PRIMARY KEY, "key" TEXT NOT NULL REFERENCES "original_file"("key"),
  "path" TEXT NOT NULL UNIQUE, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "original_upload_attempt_createdAt_idx" ON "original_upload_attempt"("createdAt");
ALTER TABLE "budget_receipt" ADD COLUMN "originalKey" TEXT;

CREATE INDEX "inventory_item_image_filePath_idx" ON "inventory_item_image"("filePath");
CREATE INDEX "inventory_item_audio_filePath_idx" ON "inventory_item_audio"("filePath");
CREATE INDEX "inventory_item_asset_filePath_idx" ON "inventory_item_asset"("filePath");
