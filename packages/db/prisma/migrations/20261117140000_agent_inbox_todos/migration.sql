CREATE TABLE "agent_inbox_todo" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "creationAuditId" TEXT NOT NULL,

  CONSTRAINT "agent_inbox_todo_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_inbox_todo_creationAuditId_fkey"
    FOREIGN KEY ("creationAuditId") REFERENCES "agent_write_audit"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "agent_inbox_todo_creationAuditId_key" ON "agent_inbox_todo" ("creationAuditId");
CREATE INDEX "agent_inbox_todo_owner_list_idx"
  ON "agent_inbox_todo" ("ownerId", "cancelledAt", "completedAt", "createdAt", "id");
