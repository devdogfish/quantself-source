CREATE TABLE "phone_jarvis_call" (
 "id" TEXT PRIMARY KEY, "callSid" TEXT UNIQUE, "slot" TEXT UNIQUE,
 "direction" TEXT NOT NULL, "captureId" TEXT NOT NULL UNIQUE,
 "expiresAt" TIMESTAMP(3) NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0,
 "authenticated" BOOLEAN NOT NULL DEFAULT false,
 "connection" TEXT NOT NULL DEFAULT 'pending', "status" TEXT NOT NULL DEFAULT 'created',
 "conversationId" TEXT UNIQUE, "archivedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "phone_jarvis_call_archivedAt_createdAt_idx" ON "phone_jarvis_call"("archivedAt", "createdAt");
