-- Genze open languages (user correction 2026-10-18): preferred_language is no
-- longer restricted to five values. Any BCP-47 language code is accepted as
-- free text; the five fully-translated UI languages live in the web client.
-- Idempotent: safe to re-run.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_preferred_language_check;
