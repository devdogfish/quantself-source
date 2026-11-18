BEGIN;

LOCK TABLE "job_missing_detail" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "job_missing_detail") THEN
    RAISE EXCEPTION 'Unexpected reminder records. Preserve the table for review.';
  END IF;
END $$;

DROP TABLE "job_missing_detail";

COMMIT;
