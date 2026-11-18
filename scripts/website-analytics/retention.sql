\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

-- Scope cleanup to the portfolio site. Self-hosted Umami has no automatic expiry.
DELETE FROM event_data
WHERE website_id = :'website_id'::uuid AND created_at < CURRENT_TIMESTAMP - INTERVAL '90 days';
DELETE FROM website_event
WHERE website_id = :'website_id'::uuid AND created_at < CURRENT_TIMESTAMP - INTERVAL '90 days';
DELETE FROM session s
WHERE s.website_id = :'website_id'::uuid AND s.created_at < CURRENT_TIMESTAMP - INTERVAL '90 days'
  AND NOT EXISTS (
    SELECT 1 FROM website_event e WHERE e.website_id = s.website_id AND e.session_id = s.session_id
  );
COMMIT;
