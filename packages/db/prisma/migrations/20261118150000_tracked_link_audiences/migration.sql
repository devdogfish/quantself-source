ALTER TABLE "tracked_link"
  DROP CONSTRAINT "tracked_link_kind_fields_check",
  ADD CONSTRAINT "tracked_link_kind_fields_check" CHECK (
    (kind = 'application' AND code ~ '^([A-Za-z0-9]{8}|[A-Za-z0-9]{16}|[a-f0-9]{24})$'
      AND application_id IS NOT NULL AND track IS NOT NULL
      AND track IN ('software', 'web-cms', 'admin-excel', 'devops', 'frontend', 'backend', 'full-stack')
      AND company IS NOT NULL AND revision IS NOT NULL AND revision > 0)
    OR
    (kind = 'share' AND code ~ '^[A-Za-z0-9]{8}$'
      AND (track IS NULL OR track IN ('client', 'software', 'web-cms', 'admin-excel', 'devops', 'frontend', 'backend', 'full-stack'))
      AND application_id IS NULL AND company IS NULL AND revision IS NULL AND sent_at IS NULL)
  );
