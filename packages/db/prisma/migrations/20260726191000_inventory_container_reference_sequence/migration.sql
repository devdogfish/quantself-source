-- Persist allocation independently from container rows so hard deletion never
-- allows a printed QR reference to point at a future container.
CREATE SEQUENCE "inventory_container_reference_seq"
AS BIGINT
START WITH 1
INCREMENT BY 1
NO CYCLE;

DO $$
DECLARE
  maximum_reference BIGINT;
BEGIN
  SELECT COALESCE(
    MAX(
      CASE
        WHEN "referenceId" ~ '^BIN-[0-9]+$'
        THEN SUBSTRING("referenceId" FROM 5)::BIGINT
        ELSE NULL
      END
    ),
    0
  )
  INTO maximum_reference
  FROM "inventory_container";

  IF maximum_reference = 0 THEN
    PERFORM setval('inventory_container_reference_seq', 1, false);
  ELSE
    PERFORM setval(
      'inventory_container_reference_seq',
      maximum_reference,
      true
    );
  END IF;
END
$$;
