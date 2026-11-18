ALTER TABLE "todo_delegation"
ADD COLUMN "handBack" JSONB,
ADD COLUMN "ownerReply" JSONB,
ADD COLUMN "accepted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "ownerEditedAt" TIMESTAMP(3),
ADD COLUMN "pendingClosure" JSONB;
