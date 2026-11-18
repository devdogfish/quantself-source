ALTER TABLE "habit_occurrence" ADD COLUMN "definitionRevision" INTEGER;
CREATE TABLE "habit_stack" (
  "ownerId" TEXT NOT NULL, "id" TEXT NOT NULL, "definition" JSONB NOT NULL,
  "archivedAt" TIMESTAMP(3), PRIMARY KEY ("ownerId", "id")
);
CREATE TABLE "habit_definition" (
  "ownerId" TEXT NOT NULL, "id" TEXT NOT NULL, "definition" JSONB NOT NULL,
  "details" JSONB NOT NULL, "archivedAt" TIMESTAMP(3), PRIMARY KEY ("ownerId", "id")
);
CREATE TABLE "habit_definition_revision" (
  "ownerId" TEXT NOT NULL, "revision" INTEGER NOT NULL,
  "commandId" TEXT NOT NULL, "payload" TEXT NOT NULL, "reason" TEXT NOT NULL,
  "changes" JSONB NOT NULL, "actor" TEXT NOT NULL, "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("ownerId", "revision"), UNIQUE ("ownerId", "commandId")
);
