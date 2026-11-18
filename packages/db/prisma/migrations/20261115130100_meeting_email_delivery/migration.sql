ALTER TABLE "meeting"
  ADD COLUMN "confirmationLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "ownerConfirmationSentAt" TIMESTAMP(3),
  ADD COLUMN "ownerConfirmationLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "reminderLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "ownerReminderSentAt" TIMESTAMP(3),
  ADD COLUMN "ownerReminderLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "cancellationLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "ownerCancellationSentAt" TIMESTAMP(3),
  ADD COLUMN "ownerCancellationLeaseUntil" TIMESTAMP(3);

-- A remaining token identifies a guest confirmation whose send was never finalized.
UPDATE "meeting"
SET "confirmationSentAt" = NULL
WHERE "status" = 'booked' AND "pendingCancelToken" IS NOT NULL;
