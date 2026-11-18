CREATE TABLE "habit_slip" (
 "ownerId" TEXT NOT NULL, "id" TEXT NOT NULL, "habitId" TEXT NOT NULL,
 "definitionSha" TEXT NOT NULL, "occurredAt" TIMESTAMP(3) NOT NULL,
 "outcome" TEXT NOT NULL, "trigger" TEXT NOT NULL DEFAULT '', "note" TEXT NOT NULL DEFAULT '',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "habit_slip_pkey" PRIMARY KEY ("ownerId", "id")
);
CREATE INDEX "habit_slip_ownerId_occurredAt_id_idx" ON "habit_slip"("ownerId", "occurredAt", "id");
