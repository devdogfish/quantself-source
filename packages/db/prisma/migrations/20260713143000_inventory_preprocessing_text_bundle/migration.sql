-- AlterTable
ALTER TABLE "inventory_preprocessing_job"
ADD COLUMN "textBundle" JSONB,
ADD COLUMN "failureDetail" JSONB,
ADD COLUMN "completedAt" TIMESTAMP(3);
