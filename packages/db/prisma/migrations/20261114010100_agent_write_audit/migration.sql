CREATE TABLE "agent_write_audit" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientName" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "revisionBefore" INTEGER NOT NULL,
  "revisionAfter" INTEGER NOT NULL,
  "before" JSONB NOT NULL,
  "after" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt" TIMESTAMP(3),

  CONSTRAINT "agent_write_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_write_audit_owner_timeline_idx"
ON "agent_write_audit" ("ownerId", "createdAt", "id");
