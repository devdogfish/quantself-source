CREATE TABLE "inventory_container_visual_bounds_override" (
  "presetKey" TEXT NOT NULL,
  "bounds" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "inventory_container_visual_bounds_override_pkey"
    PRIMARY KEY ("presetKey")
);
