ALTER TABLE "apikey"
ALTER COLUMN "rateLimitTimeWindow" SET DEFAULT 86400000,
ALTER COLUMN "rateLimitMax" SET DEFAULT 25000;

-- Upgrade credentials that still use Better Auth's 10-request daily default.
-- Reset their current window so an already exhausted credential works immediately.
UPDATE "apikey"
SET
  "rateLimitTimeWindow" = 86400000,
  "rateLimitMax" = 25000,
  "requestCount" = 0,
  "lastRequest" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "rateLimitEnabled" IS DISTINCT FROM FALSE
  AND "rateLimitMax" = 10
  AND "rateLimitTimeWindow" = 86400000;
