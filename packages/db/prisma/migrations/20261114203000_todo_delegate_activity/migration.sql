ALTER TABLE "todo_delegation"
  ADD COLUMN "assignedAt" TIMESTAMP(3),
  ADD COLUMN "lastActivityAt" TIMESTAMP(3),
  ADD CONSTRAINT "todo_delegation_activity_check" CHECK (
    "lastActivityAt" IS NULL OR (
      "delegateId" IS NOT NULL AND "assignedAt" IS NOT NULL AND "lastActivityAt" >= "assignedAt"
    )
  );

WITH assignments AS (
  SELECT "ownerId", "resourceId", "revisionAfter",
         CASE WHEN "undoneAt" IS NULL THEN "after"#>>'{delegate,id}' ELSE "before"#>>'{delegate,id}' END AS "delegateId",
         coalesce("undoneAt", "createdAt") AS "assignedAt"
  FROM "agent_write_audit"
  WHERE "resourceType" = 'todoDelegation'
    AND ("before"#>>'{delegate,id}') IS DISTINCT FROM ("after"#>>'{delegate,id}')
), active AS (
  SELECT d."ownerId", d."todoId",
         coalesce(max(a."assignedAt"), CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS "assignedAt"
  FROM "todo_delegation" d
  LEFT JOIN assignments a
    ON a."ownerId" = d."ownerId" AND a."resourceId" = d."todoId"
       AND a."revisionAfter" <= d.revision AND a."delegateId" = d."delegateId"
  WHERE d."delegateId" IS NOT NULL
  GROUP BY d."ownerId", d."todoId"
)
UPDATE "todo_delegation" d
SET "assignedAt" = active."assignedAt"
FROM active
WHERE active."ownerId" = d."ownerId" AND active."todoId" = d."todoId";
