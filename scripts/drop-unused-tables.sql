-- Removes what 3.0.0 no longer uses:
--   * pending_user           (REGISTRATION_MODE=approval sign-up queue)
--   * external_subscription  (subscriptions to secondary databases)
--   * data_source            (secondary databases)
--   * provider_registry.template (display templates, now bundled in the apps)
-- Script NOT run automatically — run it once, by hand, after 3.0.0 is deployed:
--   psql "$DATABASE_URL" -f scripts/drop-unused-tables.sql
--
-- Idempotent. Rows in pending_user are sign-ups that were never approved; check
-- them first if you ever ran with REGISTRATION_MODE=approval:
--   SELECT email, created_at FROM pending_user;

BEGIN;

-- external_subscription references data_source: drop it first.
DROP TABLE IF EXISTS external_subscription;
DROP TABLE IF EXISTS data_source;
DROP TABLE IF EXISTS pending_user;
ALTER TABLE IF EXISTS provider_registry DROP COLUMN IF EXISTS template;

COMMIT;
