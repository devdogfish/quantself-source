CREATE TABLE "notification_settings" ("ownerId" TEXT PRIMARY KEY, "enabled" BOOLEAN NOT NULL DEFAULT false, "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "morning" TEXT NOT NULL DEFAULT '09:00');
CREATE TABLE "notification_task" ("ownerId" TEXT NOT NULL, "number" INTEGER NOT NULL, "minutes" INTEGER DEFAULT 10, "updatedAt" TIMESTAMP(3) NOT NULL, PRIMARY KEY ("ownerId", "number"));
CREATE TABLE "notification_device" ("id" TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL, "endpoint" TEXT NOT NULL UNIQUE, "p256dh" TEXT NOT NULL, "auth" TEXT NOT NULL, "timeZone" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "notification_device_ownerId_idx" ON "notification_device"("ownerId");
CREATE TABLE "notification_receipt" ("deviceId" TEXT NOT NULL, "key" TEXT NOT NULL, "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "sentAt" TIMESTAMP(3), PRIMARY KEY ("deviceId", "key"));
CREATE INDEX "notification_receipt_claimedAt_idx" ON "notification_receipt"("claimedAt");
