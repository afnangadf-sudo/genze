-- Genze Step 1: core auth/account tables.
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere).

CREATE EXTENSION IF NOT EXISTS citext;

-- pgvector ships in the docker image but may be absent locally (e.g. a plain
-- Postgres used for quick tests); a missing extension must never fail migrations.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pgvector extension not available, skipping (embeddings arrive in a later step)';
END
$$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email citext UNIQUE NOT NULL,
  password_hash text,
  email_verified boolean NOT NULL DEFAULT false,
  country char(2) NOT NULL,
  totp_secret text,
  totp_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type text NOT NULL,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_tokens_user_id_idx ON email_tokens (user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  refresh_token_hash text UNIQUE NOT NULL,
  device_name text,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS consent_records (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (user_id, provider)
);
