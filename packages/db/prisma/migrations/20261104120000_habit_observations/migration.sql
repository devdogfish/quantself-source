CREATE TABLE "habit_occurrence" (
  "ownerId" TEXT NOT NULL, "habitId" TEXT NOT NULL, "date" TEXT NOT NULL,
  "definitionSha" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'open',
  "note" TEXT NOT NULL DEFAULT '', "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "habit_occurrence_pkey" PRIMARY KEY ("ownerId", "habitId", "date"),
  CONSTRAINT "habit_occurrence_status_check" CHECK ("status" IN ('open', 'done', 'minimum', 'skipped'))
);
CREATE INDEX "habit_occurrence_ownerId_date_idx" ON "habit_occurrence"("ownerId", "date");
CREATE TABLE "habit_command" (
  "ownerId" TEXT NOT NULL, "clientId" TEXT NOT NULL, "commandId" TEXT NOT NULL,
  "payload" TEXT NOT NULL, "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "habit_command_pkey" PRIMARY KEY ("ownerId", "clientId", "commandId")
);
