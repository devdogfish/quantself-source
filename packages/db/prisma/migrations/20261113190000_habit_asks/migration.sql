CREATE TABLE "habit_ask" (
  "ownerId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "habitId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "feeling" TEXT NOT NULL DEFAULT 'Other',
  "answer" JSONB,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "habit_ask_pkey" PRIMARY KEY ("ownerId", "id")
);
CREATE INDEX "habit_ask_ownerId_date_createdAt_id_idx" ON "habit_ask"("ownerId", "date", "createdAt", "id");
