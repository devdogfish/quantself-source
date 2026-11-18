CREATE TYPE "JobPrivateFieldType" AS ENUM ('text', 'email', 'phone', 'url', 'number', 'date', 'boolean', 'option', 'options');

CREATE TABLE "job_private_field" (
    "ownerId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "JobPrivateFieldType" NOT NULL,
    "options" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "ciphertext" TEXT,
    "hasValue" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_private_field_pkey" PRIMARY KEY ("ownerId", "id"),
    CONSTRAINT "job_private_field_value_presence" CHECK ("hasValue" = ("ciphertext" IS NOT NULL)),
    CONSTRAINT "job_private_field_version" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "job_private_field_ownerId_scopeKey_key_key" ON "job_private_field"("ownerId", "scopeKey", "key");
