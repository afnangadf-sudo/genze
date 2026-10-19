-- Genze Step 4 multilingual v1: per-user preferred language (en/ur/ar/tr/fa).
-- Idempotent: safe to re-run (IF NOT EXISTS; the whole action is skipped
-- when the column already exists).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_language text NOT NULL DEFAULT 'en'
  CONSTRAINT users_preferred_language_check
  CHECK (preferred_language IN ('en', 'ur', 'ar', 'tr', 'fa'));
