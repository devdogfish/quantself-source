CREATE FUNCTION "enforce_inventory_specialist_profile_category"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  required_category "InventoryCategory";
  constraint_name TEXT;
BEGIN
  IF TG_TABLE_NAME = 'inventory_clothing_profile' THEN
    required_category := 'clothing';
    constraint_name := 'inventory_clothing_profile_category_check';
  ELSIF TG_TABLE_NAME = 'inventory_remedy_profile' THEN
    required_category := 'homeopathy';
    constraint_name := 'inventory_remedy_profile_category_check';
  ELSE
    RAISE EXCEPTION 'Unsupported specialist Profile table: %', TG_TABLE_NAME;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "inventory_item"
    WHERE "id" = NEW."itemId"
      AND "category" = required_category
  ) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        CONSTRAINT = constraint_name,
        MESSAGE = format('%s requires Inventory Product category %s.', TG_TABLE_NAME, required_category);
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "inventory_clothing_profile_category_trigger"
BEFORE INSERT OR UPDATE OF "itemId"
ON "inventory_clothing_profile"
FOR EACH ROW
EXECUTE FUNCTION "enforce_inventory_specialist_profile_category"();

CREATE TRIGGER "inventory_remedy_profile_category_trigger"
BEFORE INSERT OR UPDATE OF "itemId"
ON "inventory_remedy_profile"
FOR EACH ROW
EXECUTE FUNCTION "enforce_inventory_specialist_profile_category"();

CREATE FUNCTION "enforce_inventory_item_specialist_profile_category"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."category" IS DISTINCT FROM 'clothing'::"InventoryCategory"
    AND EXISTS (
      SELECT 1
      FROM "inventory_clothing_profile"
      WHERE "itemId" = NEW."id"
    )
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_clothing_profile_category_check',
        MESSAGE = 'Inventory Product with a Clothing Profile must keep category clothing.';
  END IF;

  IF NEW."category" IS DISTINCT FROM 'homeopathy'::"InventoryCategory"
    AND EXISTS (
      SELECT 1
      FROM "inventory_remedy_profile"
      WHERE "itemId" = NEW."id"
    )
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'inventory_remedy_profile_category_check',
        MESSAGE = 'Inventory Product with a Remedy Profile must keep category homeopathy.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "inventory_item_specialist_profile_category_trigger"
BEFORE UPDATE OF "category"
ON "inventory_item"
FOR EACH ROW
EXECUTE FUNCTION "enforce_inventory_item_specialist_profile_category"();
