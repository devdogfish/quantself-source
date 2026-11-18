BEGIN;

CREATE SEQUENCE "job_application_address_number" AS integer MINVALUE 0 START 0 NO CYCLE;

CREATE FUNCTION "next_job_application_address"() RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  alphabet constant text := '23456789abcdefghjkmnpqrstuvwxyz';
  remaining integer := nextval('"job_application_address_number"');
  code text := '';
BEGIN
  IF remaining >= length(alphabet) ^ 4 THEN
    RAISE EXCEPTION 'Job Application Address space exhausted';
  END IF;
  FOR code_position IN 1..4 LOOP
    code := substr(alphabet, remaining % length(alphabet) + 1, 1) || code;
    remaining := remaining / length(alphabet);
  END LOOP;
  RETURN 'luigi.' || code || '@luigigirke.com';
END;
$$;

ALTER TABLE "job_application"
  ADD COLUMN "applicationAddress" TEXT NOT NULL DEFAULT "next_job_application_address"(),
  ADD COLUMN "sesMessageId" TEXT;

CREATE UNIQUE INDEX "job_application_applicationAddress_key" ON "job_application" ("applicationAddress");
CREATE UNIQUE INDEX "job_application_sesMessageId_key" ON "job_application" ("sesMessageId");

ALTER TABLE "job_application"
  ADD CONSTRAINT "job_application_address_format"
  CHECK ("applicationAddress" ~ '^luigi\.[23456789a-hjkmnp-z]{4}@luigigirke\.com$');

COMMIT;
