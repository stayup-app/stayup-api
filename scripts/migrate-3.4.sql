-- Adds what 3.4.0 needs, on a database created before it:
--   * item_state  (read / saved items, synced across a user's devices)
--   * user_repository.folder
--   * push_token  (Expo tokens of mobile devices)
-- Run it ONCE, BEFORE deploying 3.4.0 (the purge and the feed endpoints query
-- these tables):
--   psql "$DATABASE_URL" -f scripts/migrate-3.4.sql
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS item_state (
  user_id  TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  item_id  INTEGER NOT NULL REFERENCES connector_item(id) ON DELETE CASCADE,
  read_at  TIMESTAMPTZ,
  saved_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, item_id)
);

ALTER TABLE user_repository ADD COLUMN IF NOT EXISTS folder TEXT;

CREATE TABLE IF NOT EXISTS push_token (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  lang       TEXT NOT NULL DEFAULT 'en',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
