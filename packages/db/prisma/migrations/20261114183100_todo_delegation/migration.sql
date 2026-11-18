CREATE TABLE "todo_delegation" (
  "ownerId" TEXT NOT NULL,
  "todoId" TEXT NOT NULL,
  "repository" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "delegateId" TEXT,
  "delegateName" TEXT,
  "revision" INTEGER NOT NULL,

  CONSTRAINT "todo_delegation_pkey" PRIMARY KEY ("ownerId", "todoId"),
  CONSTRAINT "todo_delegation_delegate_check" CHECK (("delegateId" IS NULL) = ("delegateName" IS NULL))
);

CREATE INDEX "todo_delegation_agent_lookup_idx"
ON "todo_delegation" ("ownerId", "delegateId", "repository", "number");
